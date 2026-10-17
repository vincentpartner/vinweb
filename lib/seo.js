// Etappe 3 (Vollausbau) – SEO.
//
// Arbeitsteilung mit dem Schwesterwerkzeug SiteSett:
//   SiteSett  = der Redaktionsplatz für die SEO-DETAILARBEIT
//               (FAQs, Schema-Typen, OG-Bilder, Analytics, Verifizierung …)
//   Sitepilot    = übernimmt dessen Config VOLLSTÄNDIG und prägt sie beim
//               Produktions-Build in die Seiten ein.
//
// Grundsatz: SEO wird NIE in die Quelle geschrieben, nur in den Build.
// Einzige Ausnahme: BILDER aus der SiteSett-Config (OG-Bilder, Favicon) –
// das sind Inhalte, keine Metadaten. Sie werden beim Import als echte
// Dateien in die Quelle gelegt, damit Verweise darauf überall funktionieren.

import fs from 'node:fs/promises'
import path from 'node:path'
import { zuBuildPfad } from './build.js'

// ---------------------------------------------------------------------------
// Datenmodell
// ---------------------------------------------------------------------------

export function leeresSeo () {
  return {
    site: {
      domain: '', name: '', legalName: '', beschreibung: '',
      email: '', telefon: '', strasse: '', plz: '', ort: '', land: 'CH',
      sprache: 'de', ogBild: '', logo: '', orgTyp: 'Organization',
      sameAs: '',            // kommagetrennte Profil-Adressen (LinkedIn …)
      oeffnungszeiten: '', lat: '', lng: '',
      twitterSite: '', themeColor: '',
      gscVerification: '', bingVerification: '',
      analyticsProvider: 'none', analyticsId: '', matomoUrl: '',
      globalHead: '', globalBodyTop: '',
      indexNowKey: '',
      faviconDatei: '',      // relativer Pfad im Projekt (beim Import gesetzt)
    },
    pages: {},               // Schlüssel = Dateiname in der Quelle
    redirects: [],
  }
}

export function leereSeite () {
  return {
    titel: '', beschreibung: '', keywords: '',
    ogTitel: '', ogBeschreibung: '', ogBild: '',
    typ: 'website', twitterCard: 'summary_large_image',
    indexierbar: true,
    canonical: '',           // leer = eigene Adresse; sonst volle URL der Hauptversion (aus SiteSett)
    robotsZusatz: '',        // weitere robots-Angaben ausser index/noindex, z. B. «max-image-preview:large»
    ogBildAlt: '',           // Bildbeschreibung fürs Vorschaubild (og:image:alt)
    jsonldEigen: '',         // eigener JSON-LD-Block (gewinnt über den generierten)
    faqs: [],                // [{q, a}]
  }
}

// ---------------------------------------------------------------------------
// Zusammenführen: SiteSett-Import ÜBERSCHREIBT nicht mehr, er ergänzt.
// ---------------------------------------------------------------------------
// Regeln:
//   - Ein GEFÜLLTES Feld aus der neuen Config gewinnt (die SiteSett-Runde ist
//     eine bewusste Gesamtpflege).
//   - Ein LEERES Feld in der neuen Config lässt den bestehenden Wert stehen –
//     so überlebt Handarbeit aus dem SEO-Reiter einen älteren Schnappschuss.
//   - Seiten, die nur im bestehenden Stand existieren (z. B. in Sitepilot neu
//     erstellte), bleiben vollständig erhalten.
//   - Weiterleitungen werden vereinigt (gleiches «von» → neue gewinnt).

const istGefuellt = (w) =>
  Array.isArray(w) ? w.length > 0 : typeof w === 'boolean' ? true : String(w ?? '').trim() !== ''

function felderZusammen (alt, neu) {
  const raus = { ...alt }
  for (const [feld, wert] of Object.entries(neu)) {
    if (istGefuellt(wert)) raus[feld] = wert
  }
  return raus
}

export function seoZusammenfuehren (bestehend, neu) {
  if (!bestehend) return { seo: neu, geschuetzt: { seiten: 0, felder: 0 } }
  const raus = leeresSeo()
  const geschuetzt = { seiten: 0, felder: 0 }

  raus.site = felderZusammen({ ...leeresSeo().site, ...bestehend.site }, neu.site || {})

  // Seiten: erst alle bestehenden, dann die neuen feldweise darüber.
  raus.pages = {}
  for (const [datei, seite] of Object.entries(bestehend.pages || {})) {
    raus.pages[datei] = { ...leereSeite(), ...seite }
  }
  for (const [datei, seite] of Object.entries(neu.pages || {})) {
    if (raus.pages[datei]) {
      const vorher = raus.pages[datei]
      const nachher = felderZusammen(vorher, seite)
      for (const f of Object.keys(vorher)) {
        if (istGefuellt(vorher[f]) && !istGefuellt(seite[f]) && f !== 'typ' && f !== 'twitterCard') {
          geschuetzt.felder++
        }
      }
      raus.pages[datei] = nachher
    } else {
      raus.pages[datei] = { ...leereSeite(), ...seite }
    }
  }
  for (const datei of Object.keys(bestehend.pages || {})) {
    if (!(neu.pages || {})[datei]) geschuetzt.seiten++
  }

  // Weiterleitungen vereinigen – neue gewinnen bei gleichem «von».
  const proVon = new Map()
  for (const r of [...(bestehend.redirects || []), ...(neu.redirects || [])]) {
    if (r?.von && r?.nach) proVon.set(r.von, r)
  }
  raus.redirects = [...proVon.values()]

  return { seo: raus, geschuetzt }
}

// ---------------------------------------------------------------------------
// Übernahme aus SiteSett
// ---------------------------------------------------------------------------

// Macht aus einer Daten-URL { endung, puffer } – oder null.
function datenUrlLesen (u) {
  const m = /^data:image\/([a-z0-9+]+);base64,(.+)$/is.exec(String(u || ''))
  if (!m) return null
  const endung = m[1] === 'jpeg' ? 'jpg' : m[1].replace(/[^a-z0-9]/g, '')
  return { endung, puffer: Buffer.from(m[2], 'base64') }
}

// Nur harmlose relative Pfade zulassen (kein Ausbruch, keine Windows-Laufwerke).
function pfadSauber (p) {
  const s = String(p || '').replace(/^\/+/, '').trim()
  if (!s || s.split(/[/\\]/).includes('..') || /^[a-zA-Z]:/.test(s)) return null
  return s
}

// Canonical aus SiteSett: «Andere URL» (custom) oder «aus der Quelle übernehmen» (source).
// Standard (eigene Adresse) bleibt leer – dann setzt der Build die saubere Adresse selbst.
function canonicalAusSiteSett (p, domain, datei) {
  if (p.canonicalMode === 'custom' && /^https?:\/\//i.test(p.canonicalUrl || '')) return String(p.canonicalUrl).trim()
  if (p.canonicalMode === 'source' && p._srcCanonical) {
    const c = String(p._srcCanonical).trim()
    if (/^https?:\/\//i.test(c)) return c
    if (!domain) return ''
    try { return new URL(c, domain.replace(/\/+$/, '') + '/' + String(datei).replace(/^\/+/, '')).href } catch { return '' }
  }
  return ''
}

// robots-Angaben der Quelle ohne index/noindex (das steuert «indexierbar»);
// «none» bedeutet noindex + nofollow, darum bleibt davon das nofollow.
function robotsZusatzAus (roh) {
  const teile = String(roh || '').split(/\s*,\s*/).map(x => x.trim()).filter(Boolean)
  const rest = teile.filter(x => !/^(index|noindex|all|none)$/i.test(x))
  if (teile.some(x => /^none$/i.test(x)) && !rest.some(x => /follow$/i.test(x))) rest.push('nofollow')
  // Nur bekannte, harmlose Direktiven durchlassen (landen in einem HTML-Attribut)
  return rest.filter(x => /^[a-z-]+(:[a-z0-9-]+)?$/i.test(x)).join(', ')
}

// Robots-Inhalt einer Seite. Ohne Zusatz und indexierbar: kein Tag (Standard index, follow).
function robotsInhalt (seite) {
  const zusatz = String(seite.robotsZusatz || '').split(/\s*,\s*/).filter(Boolean)
  if (seite.indexierbar === false) {
    if (!zusatz.some(x => /follow$/i.test(x))) zusatz.unshift('nofollow')
    return ['noindex', ...zusatz].join(', ')
  }
  return zusatz.length ? ['index', ...zusatz].join(', ') : ''
}

// Zeigt das Canonical auf eine andere Adresse? Dann gehört die Seite nicht in die Sitemap.
function canonicalWoanders (seo, rel, seite) {
  if (!/^https?:\/\//i.test(seite.canonical || '')) return false
  const norm = u => String(u).replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
  return norm(seite.canonical) !== norm(absUrl(seo.site.domain, rel))
}

/**
 * Übersetzt eine sitesett-config.json in unser Modell.
 * Gibt zusätzlich die zu materialisierenden Bilddateien zurück
 * (Uploads + Favicon) – der Aufrufer schreibt sie in die Quelle.
 * Der API-Schlüssel aus der SiteSett-Sicherung wird BEWUSST verworfen.
 */
export function ausSiteSett (roh) {
  const seo = leeresSeo()
  const s = roh.site || {}
  Object.assign(seo.site, {
    domain: s.domain || '',
    name: s.siteName || '',
    legalName: s.legalName || '',
    beschreibung: s.description || '',
    email: s.email || '', telefon: s.phone || '',
    strasse: s.street || '', plz: s.postalCode || '', ort: s.locality || '',
    land: s.country || 'CH', sprache: s.inLanguage || 'de',
    ogBild: s.defaultOgImage || '', logo: s.logoUrl || '',
    orgTyp: s.orgType || 'Organization',
    sameAs: s.sameAs || '',
    oeffnungszeiten: s.openingHours || '', lat: s.lat || '', lng: s.lng || '',
    twitterSite: s.twitterSite || '', themeColor: s.themeColor || '',
    gscVerification: s.gscVerification || '', bingVerification: s.bingVerification || '',
    analyticsProvider: s.analyticsProvider || 'none',
    analyticsId: s.analyticsId || '', matomoUrl: s.matomoUrl || '',
    globalHead: s.globalHead || '', globalBodyTop: s.globalBodyTop || '',
    indexNowKey: s.indexNowKey || '',
  })

  for (const [datei, p] of Object.entries(roh.pages || {})) {
    if (p.include === false) continue
    seo.pages[datei] = {
      ...leereSeite(),
      titel: p.title || '',
      beschreibung: p.description || '',
      keywords: p.keywords || '',
      ogTitel: p.ogTitle || '',
      ogBeschreibung: p.ogDescription || '',
      ogBild: p.ogImage || '',
      typ: p.ogType === 'article' ? 'article' : 'website',
      twitterCard: p.twitterCard || 'summary_large_image',
      indexierbar: p.indexable !== false,
      canonical: canonicalAusSiteSett(p, s.domain || '', datei),
      robotsZusatz: robotsZusatzAus(p._srcRobots),
      ogBildAlt: p.ogImageAlt || '',
      // Ein von Hand gepflegter JSON-LD-Block gewinnt über den generierten –
      // aber nur, wenn die Automatik in SiteSett ausgeschaltet wurde.
      jsonldEigen: (p.jsonldAuto === false && p.jsonld) ? String(p.jsonld) : '',
      faqs: Array.isArray(p.faqs)
        ? p.faqs.filter(f => f?.q && f?.a).map(f => ({ q: String(f.q), a: String(f.a) }))
        : [],
    }
  }

  for (const r of roh.redirects || []) {
    if (r.from && r.to) seo.redirects.push({ von: r.from, nach: r.to })
  }

  // --- Bilder zum Materialisieren einsammeln ---
  const dateien = []
  for (const [relRoh, wert] of Object.entries(roh.uploads || {})) {
    const rel = pfadSauber(relRoh)
    const bild = datenUrlLesen(wert)
    if (rel && bild) dateien.push({ pfad: rel, puffer: bild.puffer })
  }
  const fav = datenUrlLesen(s.faviconData)
  if (fav) {
    seo.site.faviconDatei = 'favicon.' + fav.endung
    dateien.push({ pfad: seo.site.faviconDatei, puffer: fav.puffer })
  }

  return { seo, dateien }
}

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------

const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Saubere Adressen: /webdesign statt /webdesign.html (Firmenkonvention).
// Die .htaccess bildet die saubere Adresse intern auf die Datei ab.
function absUrl (domain, rel) {
  const basis = domain.replace(/\/+$/, '')
  if (rel === 'index.html') return basis + '/'
  // Sprach-Startseiten (en/index.html) heissen im Netz /en/ – nicht /en/index.
  if (/(^|\/)index\.html?$/i.test(rel)) return basis + '/' + rel.replace(/index\.html?$/i, '')
  return basis + '/' + rel.replace(/\.html?$/i, '')
}

// Sprache einer Seite: liegt sie in einem Sprachordner (en/, fr/ …), zählt
// der Ordner – sonst die Site-Sprache. Mehr braucht es für bis zu vier
// Sprachen nicht, solange jede Sprache ihren eigenen Ordner hat.
const SPRACH_ORDNER = new Set(['de', 'en', 'fr', 'it', 'rm', 'es', 'pt', 'nl'])
export function seitenSprache (seo, rel) {
  const kopf = String(rel).split('/')[0].toLowerCase()
  if (String(rel).includes('/') && SPRACH_ORDNER.has(kopf)) return kopf
  return seo.site.sprache || 'de'
}

// Bild-Verweise absolut machen – Google und die sozialen Netzwerke verlangen
// bei og:image volle Adressen. Daten-URLs gehören hier nie hin.
function absBild (domain, wert) {
  const w = String(wert || '').trim()
  if (!w || w.startsWith('data:')) return ''
  if (/^https?:\/\//i.test(w)) return w
  return domain.replace(/\/+$/, '') + '/' + w.replace(/^\/+/, '')
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

function jsonLd (seo, rel, seite) {
  // Ein eigener Block aus SiteSett gewinnt – sofern er gültiges JSON ist.
  if (seite.jsonldEigen) {
    try {
      JSON.parse(seite.jsonldEigen)
      // Gleiche Absicherung wie beim generierten Block (Astra-Fund 26).
      return seite.jsonldEigen.replace(/</g, '\\u003c')
    } catch { /* kaputt – dann eben der generierte */ }
  }

  const d = seo.site.domain.replace(/\/+$/, '')
  const url = absUrl(seo.site.domain, rel)
  const graph = []

  const org = {
    '@type': seo.site.orgTyp || 'Organization',
    '@id': d + '/#org',
    name: seo.site.name,
    url: d + '/',
  }
  if (seo.site.legalName) org.legalName = seo.site.legalName
  const logoAbs = absBild(seo.site.domain, seo.site.logo)
  if (logoAbs) org.logo = logoAbs
  if (seo.site.email) org.email = seo.site.email
  if (seo.site.telefon) org.telephone = seo.site.telefon
  if (seo.site.strasse) {
    org.address = {
      '@type': 'PostalAddress',
      streetAddress: seo.site.strasse,
      postalCode: seo.site.plz,
      addressLocality: seo.site.ort,
      addressCountry: seo.site.land,
    }
  }
  if (seo.site.lat && seo.site.lng) {
    org.geo = { '@type': 'GeoCoordinates', latitude: seo.site.lat, longitude: seo.site.lng }
  }
  if (seo.site.oeffnungszeiten) org.openingHours = seo.site.oeffnungszeiten
  const profile = String(seo.site.sameAs || '').split(/[\s,]+/).filter(x => /^https?:/i.test(x))
  if (profile.length) org.sameAs = profile
  graph.push(org)

  graph.push({
    '@type': 'WebSite', '@id': d + '/#website',
    url: d + '/', name: seo.site.name,
    inLanguage: seo.site.sprache,
    publisher: { '@id': d + '/#org' },
  })
  graph.push({
    '@type': 'WebPage', '@id': url + '#webpage',
    url, name: seite.titel || seo.site.name,
    description: seite.beschreibung || undefined,
    inLanguage: seitenSprache(seo, rel),
    isPartOf: { '@id': d + '/#website' },
  })
  if (rel !== 'index.html') {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Start', item: d + '/' },
        { '@type': 'ListItem', position: 2, name: seite.titel || rel, item: url },
      ],
    })
  }
  // FAQs aus SiteSett werden als FAQPage eingeprägt – das ist der Baustein,
  // der in den Google-Treffern die aufklappbaren Fragen erzeugt.
  if (seite.faqs?.length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': url + '#faq',
      mainEntity: seite.faqs.map(f => ({
        '@type': 'Question', name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    })
  }
  // Astra-Fund 26 (16.10.): «<» im JSON escapen – ein «</script>» in FAQ-
  // oder Firmendaten würde sonst den JSON-LD-Block beenden und eigenes
  // HTML/Skript einschleusen. < ist in JSON gleichwertig.
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2)
    .replace(/</g, '\\u003c')
}

// ---------------------------------------------------------------------------
// Analytics-Schnipsel (nur wenn in SiteSett eingerichtet)
// ---------------------------------------------------------------------------

function analyticsSchnipsel (site) {
  // Astra-Fund 26 (16.10.): Diese Werte landen in SKRIPT-Kontexten – dort
  // hilft HTML-Escaping nicht. Darum strenge Formprüfung statt Escaping:
  // was nicht wie eine Kennung/Adresse aussieht, wird gar nicht eingebaut.
  const idOk = /^[A-Za-z0-9_-]{1,64}$/.test(String(site.analyticsId || ''))
  if (site.analyticsProvider === 'ga4' && idOk) {
    const id = site.analyticsId
    return `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>\n`
      + `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');</script>`
  }
  if (site.analyticsProvider === 'matomo' && site.matomoUrl && idOk) {
    const u = String(site.matomoUrl).replace(/\/+$/, '')
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[a-z0-9._/-]*)?$/i.test(u)) return ''
    return '<script>var _paq=window._paq=window._paq||[];_paq.push(["trackPageView"]);_paq.push(["enableLinkTracking"]);'
      + `(function(){var u="${u}/";_paq.push(["setTrackerUrl",u+"matomo.php"]);_paq.push(["setSiteId","${site.analyticsId}"]);`
      + 'var d=document,g=d.createElement("script"),s=d.getElementsByTagName("script")[0];g.async=true;g.src=u+"matomo.js";s.parentNode.insertBefore(g,s);})();</script>'
  }
  return ''
}

// ---------------------------------------------------------------------------
// Eine HTML-Datei anreichern
// ---------------------------------------------------------------------------

const MARKE_START = '<!-- sitepilot-seo -->'
const MARKE_ENDE = '<!-- /sitepilot-seo -->'
const BODY_START = '<!-- sitepilot-seo-body -->'
const BODY_ENDE = '<!-- /sitepilot-seo-body -->'

export function htmlAnreichern (html, seo, rel, seite) {
  // Frühere Sitepilot-Blöcke entfernen – so bleibt das Ganze wiederholbar.
  html = html.replace(new RegExp(MARKE_START + '[\\s\\S]*?' + MARKE_ENDE + '\\n?', 'g'), '')
  html = html.replace(new RegExp(BODY_START + '[\\s\\S]*?' + BODY_ENDE + '\\n?', 'g'), '')

  // ------------------------------------------------------------------
  // Vorrangregel, Feld für Feld:  SEO-Tabelle  >  Wert in der Seite  >  Site-Standard.
  // Seiten aus Mini/Midi bringen oft eigene Titel und OG-Angaben mit (der
  // Kunde pflegt sie im Post-Reiter). Die dürfen NIE stumpf überschrieben
  // werden – nur eine bewusst gefüllte Tabelle gewinnt.
  // ------------------------------------------------------------------
  const ausDatei = {
    titel: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || '',
    beschreibung: (html.match(/<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i) || [])[1] || '',
    ogTitel: (html.match(/<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i) || [])[1] || '',
    ogBeschreibung: (html.match(/<meta[^>]+property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']*)["']/i) || [])[1] || '',
    ogBild: (html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']*)["']/i) || [])[1] || '',
  }
  // Unmarkierte OG-/Twitter-/Canonical-Tags entfernen – ihre Werte sind jetzt
  // ausgelesen und fliessen unten in den Sitepilot-Block. So gibt es im Build
  // GENAU EINE Wahrheit und nie doppelte Tags (Facebook nähme sonst irgendeinen).
  html = html
    .replace(/[ \t]*<meta[^>]+property\s*=\s*["'](?:og|article):[^>]*>\n?/gi, '')
    .replace(/[ \t]*<meta[^>]+name\s*=\s*["']twitter:[^>]*>\n?/gi, '')
    .replace(/[ \t]*<link[^>]+rel\s*=\s*["']canonical["'][^>]*>\n?/gi, '')
    // Astra-Fund 46 (16.10.): Vorhandene robots-Angaben der Seite räumen –
    // die SEO-Tabelle ist die eine Wahrheit; sonst stünde «indexierbar»
    // in der Tabelle neben einem alten noindex im HTML.
    .replace(/[ \t]*<meta[^>]+name\s*=\s*["']robots["'][^>]*>\n?/gi, '')

  // Titel: Tabelle gewinnt; ohne Tabellenwert bleibt der Seiten-Titel stehen.
  // Astra-Fund 45 (16.10.): Nutzertexte IMMER über eine Ersetzungs-FUNKTION
  // einsetzen – in einer Ersetzungs-Zeichenfolge würde «$&» und Co. von
  // String.replace interpretiert und das HTML beschädigt.
  const titel = seite.titel || ausDatei.titel || seo.site.name
  if (seite.titel) {
    if (/<title[^>]*>[\s\S]*?<\/title>/i.test(html)) {
      html = html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, () => '<title>' + esc(titel) + '</title>')
    } else {
      html = html.replace(/<head([^>]*)>/i, (g, attr) => '<head' + attr + '>\n<title>' + esc(titel) + '</title>')
    }
  } else if (!ausDatei.titel && titel) {
    // Seite hatte gar keinen Titel – dann wenigstens den Site-Namen setzen.
    html = html.replace(/<head([^>]*)>/i, (g, attr) => '<head' + attr + '>\n<title>' + esc(titel) + '</title>')
  }
  const beschreibung = seite.beschreibung || ausDatei.beschreibung || ''
  if (seite.beschreibung) {
    const meta = '<meta name="description" content="' + esc(beschreibung) + '">'
    if (/<meta[^>]+name\s*=\s*["']description["'][^>]*>/i.test(html)) {
      html = html.replace(/<meta[^>]+name\s*=\s*["']description["'][^>]*>/i, () => meta)
    } else {
      html = html.replace(/<\/title>/i, () => '</title>\n' + meta)
    }
  }

  const url = absUrl(seo.site.domain, rel)
  const istStart = rel === 'index.html'
  const og = absBild(seo.site.domain, seite.ogBild || ausDatei.ogBild || seo.site.ogBild)
  const analytics = analyticsSchnipsel(seo.site)

  const kopf = [
    MARKE_START,
    `<link rel="canonical" href="${esc(/^https?:\/\//i.test(seite.canonical || '') ? seite.canonical : url)}">`,
    robotsInhalt(seite) ? `<meta name="robots" content="${esc(robotsInhalt(seite))}">` : null,
    seite.keywords ? `<meta name="keywords" content="${esc(seite.keywords)}">` : null,
    seo.site.themeColor ? `<meta name="theme-color" content="${esc(seo.site.themeColor)}">` : null,
    seo.site.faviconDatei ? `<link rel="icon" href="/${esc(seo.site.faviconDatei)}">` : null,
    // Die Such-Verifizierungen gehören auf die Startseite – dort suchen
    // Google und Bing danach.
    istStart && seo.site.gscVerification
      ? `<meta name="google-site-verification" content="${esc(seo.site.gscVerification)}">` : null,
    istStart && seo.site.bingVerification
      ? `<meta name="msvalidate.01" content="${esc(seo.site.bingVerification)}">` : null,
    `<meta property="og:type" content="${seite.typ === 'article' ? 'article' : 'website'}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:title" content="${esc(seite.ogTitel || ausDatei.ogTitel || titel)}">`,
    (seite.ogBeschreibung || beschreibung)
      ? `<meta property="og:description" content="${esc(seite.ogBeschreibung || ausDatei.ogBeschreibung || beschreibung)}">` : null,
    og ? `<meta property="og:image" content="${esc(og)}">` : null,
    og && seite.ogBildAlt ? `<meta property="og:image:alt" content="${esc(seite.ogBildAlt)}">` : null,
    seo.site.name ? `<meta property="og:site_name" content="${esc(seo.site.name)}">` : null,
    seo.site.sprache ? `<meta property="og:locale" content="${esc(seo.site.sprache === 'de' ? 'de_CH' : seo.site.sprache)}">` : null,
    `<meta name="twitter:card" content="${esc(seite.twitterCard || 'summary_large_image')}">`,
    seo.site.twitterSite ? `<meta name="twitter:site" content="${esc(seo.site.twitterSite)}">` : null,
    '<script type="application/ld+json">',
    jsonLd(seo, rel, seite),
    '</script>',
    analytics || null,
    seo.site.globalHead || null,
    MARKE_ENDE,
  ].filter(Boolean)

  html = html.replace(/<\/head>/i, () => kopf.join('\n') + '\n</head>')

  // Direkt nach <body> (Tag-Manager-noscript u. Ä. aus SiteSett).
  if (seo.site.globalBodyTop) {
    html = html.replace(/<body([^>]*)>/i,
      (g, attr) => '<body' + attr + '>\n' + BODY_START + '\n' + seo.site.globalBodyTop + '\n' + BODY_ENDE)
  }
  return html
}

// ---------------------------------------------------------------------------
// Begleitdateien
// ---------------------------------------------------------------------------

export function sitemapBauen (seo, eintraege) {
  const heute = new Date().toISOString().slice(0, 10)
  const urls = eintraege
    .filter(e => e.indexierbar !== false && !canonicalWoanders(seo, e.rel, e))
    .map(e => `  <url>\n    <loc>${esc(absUrl(seo.site.domain, e.rel))}</loc>\n    <lastmod>${heute}</lastmod>\n  </url>`)
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.join('\n') + '\n</urlset>\n'
}

export function robotsBauen (seo) {
  const d = seo.site.domain.replace(/\/+$/, '')
  return 'User-agent: *\nAllow: /\n\nSitemap: ' + d + '/sitemap.xml\n'
}

export function htaccessBauen (seo) {
  const zeilen = [
    '# Von Sitepilot erzeugt – Änderungen hier gehen beim nächsten Build verloren.',
    '',
    'AddDefaultCharset UTF-8',
    'ErrorDocument 404 /404.html',
    '',
    '# Saubere Adressen: /kontakt statt /kontakt.html',
    'Options -MultiViews',
    '<IfModule mod_rewrite.c>',
    '  RewriteEngine On',
    '  # Jede Startseite hat genau EINE Adresse: / bzw. /en/ fuer Sprachordner.',
    '  RewriteRule ^(.+/)?index\\.html$ /$1 [R=301,L]',
    '  RewriteRule ^(.+/)?index$ /$1 [R=301,L]',
    '  # Alte .html-Adressen dauerhaft auf die saubere Form umleiten.',
    '  # REDIRECT_STATUS ist nur bei der ECHTEN Anfrage leer - verhindert die',
    '  # Schleife mit der internen Abbildung unten. (THE_REQUEST scheitert auf',
    '  # manchen Shared-Hosting-Apaches, dieses Muster laeuft ueberall.)',
    '  RewriteCond %{ENV:REDIRECT_STATUS} ^$',
    '  # 404.html ausnehmen: sonst wird die Fehlerseite selbst umgeleitet und',
    '  # aus echten 404ern wuerden 301+200 (Soft-404, schlecht fuer Google).',
    '  RewriteCond %{REQUEST_URI} !^/404\\.html$',
    '  RewriteRule ^(.+)\\.html$ /$1 [R=301,L,E=UMLEITUNG:1]',
    '  # Saubere Adresse intern auf die Datei abbilden',
    '  RewriteCond %{REQUEST_FILENAME} !-d',
    '  RewriteCond %{REQUEST_FILENAME}.html -f',
    '  RewriteRule ^(.*)$ $1.html [L]',
    '</IfModule>',
    '',
    '# Justierungs-Dateien der Bild-Komponenten muessen ladbar sein -',
    '# viele Hoster (auch Cyon) sperren Punkt-Dateien serverseitig.',
    '<FilesMatch "\\.state\\.json$">',
    '  Require all granted',
    '</FilesMatch>',
    '',
    '# Zwischenspeicher-Regeln: HTML immer frisch pruefen, gehashte media/-Dateien',
    '# ewig, uebrige Dateien kurz - so erscheinen Updates sofort.',
    '<IfModule mod_headers.c>',
    '  <FilesMatch "\\.(html?)$">',
    '    Header set Cache-Control "no-cache, must-revalidate"',
    '  </FilesMatch>',
    '  <FilesMatch "\\.(css|js|json)$">',
    '    Header set Cache-Control "max-age=600, must-revalidate"',
    '  </FilesMatch>',
    '  # Justierungs-Dateien tragen Inhalt - immer frisch pruefen.',
    '  <FilesMatch "\\.state\\.json$">',
    '    Header set Cache-Control "no-cache, must-revalidate"',
    '  </FilesMatch>',
    '  <FilesMatch "\\.(jpe?g|png|webp|gif|svg|avif|woff2?|mp4|webm)$">',
    '    Header set Cache-Control "max-age=86400"',
    '  </FilesMatch>',
    '</IfModule>',
    '<IfModule mod_headers.c>',
    '  # media/-Dateien tragen ihren Inhalts-Hash im Namen - aendern sich nie.',
    '  SetEnvIf Request_URI "^/media/" MEDIA_HASHED',
    '  Header set Cache-Control "max-age=31536000, immutable" env=MEDIA_HASHED',
    '</IfModule>',
    '',
    '# Umleitungen nur KURZ merken lassen: Browser duerfen 301 sonst dauerhaft',
    '# festhalten - nach Strukturaenderungen zeigen sie dann ins Leere.',
    '<IfModule mod_headers.c>',
    '  Header always set Cache-Control "max-age=300" env=UMLEITUNG',
    '  Header always set Cache-Control "max-age=300" env=REDIRECT_UMLEITUNG',
    '</IfModule>',
    '',
    '# Sicherheits-Kopfzeilen',
    '<IfModule mod_headers.c>',
    '  Header set X-Content-Type-Options "nosniff"',
    '  Header set X-Frame-Options "SAMEORIGIN"',
    '  Header set Referrer-Policy "strict-origin-when-cross-origin"',
    '</IfModule>',
  ]
  if (seo.redirects.length) {
    zeilen.push('', '# Weiterleitungen alter Adressen (301 = dauerhaft, Google zieht um)')
    for (const r of seo.redirects) {
      // Astra-Fund 27 (16.10.): Nur saubere Pfade/Adressen durchlassen –
      // ein Zeilenumbruch oder Leerzeichen im importierten Ziel würde sonst
      // eigene Apache-Direktiven erzeugen bzw. die .htaccess beschädigen.
      const von = String(r.von || '').trim()
      const nach = String(r.nach || '').trim()
      if (!/^\/[^\s"'<>\\]*$/.test(von)) continue
      if (!/^(https?:\/\/[a-z0-9.-]+)?\/[^\s"'<>\\]*$/i.test(nach)) continue
      zeilen.push(`Redirect 301 ${von} ${nach}`)
    }
  }
  return zeilen.join('\n') + '\n'
}

export function vierNullVierBauen (seo) {
  return `<!DOCTYPE html>
<html lang="${esc(seo.site.sprache || 'de')}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seite nicht gefunden — ${esc(seo.site.name)}</title>
<meta name="robots" content="noindex">
</head>
<body style="display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;font-family:sans-serif">
<div>
  <p style="font-size:64px;font-weight:800;margin:0">404</p>
  <h1 style="font-size:20px;margin:8px 0 16px">Diese Seite gibt es nicht (mehr).</h1>
  <p><a href="/">Zur Startseite</a></p>
</div>
</body>
</html>
`
}

export function llmsBauen (seo, eintraege) {
  const zeilen = [
    '# ' + seo.site.name, '',
    seo.site.beschreibung ? '> ' + seo.site.beschreibung : null, '',
    '## Seiten', '',
    ...eintraege
      .filter(e => e.indexierbar !== false)
      .map(e => `- [${e.titel || e.rel}](${absUrl(seo.site.domain, e.rel)})`
        + (e.beschreibung ? ': ' + e.beschreibung : '')),
  ].filter(x => x !== null)
  return zeilen.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Auf einen fertigen Build anwenden
// ---------------------------------------------------------------------------

export async function seoAnwenden (seo, buildOrdner) {
  if (!seo?.site?.domain) {
    return { uebersprungen: 'Keine Domain im Site-Profil – SEO wurde nicht angewendet.' }
  }

  const buildName = new Map()
  for (const quelle of Object.keys(seo.pages)) buildName.set(zuBuildPfad(quelle), seo.pages[quelle])

  // ALLE Seiten finden, auch in Sprach- und Unterordnern (en/, fr/ …) –
  // nur Technik-Ordner bleiben draussen: assets/ (heruntergeladene fremde
  // Quellen) und media/ (eingebackene Bild-Uploads) sind keine Seiten.
  const dateien = []
  async function htmlSammeln (ordner, vor = '') {
    for (const e of await fs.readdir(ordner, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const rel = vor + e.name
      if (e.isDirectory()) {
        if (/^(assets|media)$/i.test(e.name) && !vor) continue
        await htmlSammeln(path.join(ordner, e.name), rel + '/')
      } else if (/\.html?$/i.test(e.name) && e.name.toLowerCase() !== '404.html'
        && !/^\d{1,2}[a-z]?_/.test(e.name)) {   // nummerierte Entwürfe nie ins SEO
        dateien.push(rel)
      }
    }
  }
  await htmlSammeln(buildOrdner)
  dateien.sort()
  const eintraege = []
  let angereichert = 0

  for (const rel of dateien) {
    const seite = { ...leereSeite(), ...(buildName.get(rel) || seo.pages[rel] || {}) }
    const voll = path.join(buildOrdner, rel)
    const vorher = await fs.readFile(voll, 'utf8')
    const nachher = htmlAnreichern(vorher, seo, rel, seite)
    if (nachher !== vorher) {
      await fs.writeFile(voll, nachher, 'utf8')
      angereichert++
    }
    eintraege.push({ rel, ...seite })
  }

  await fs.writeFile(path.join(buildOrdner, 'sitemap.xml'), sitemapBauen(seo, eintraege), 'utf8')
  await fs.writeFile(path.join(buildOrdner, 'robots.txt'), robotsBauen(seo), 'utf8')
  await fs.writeFile(path.join(buildOrdner, '.htaccess'), htaccessBauen(seo), 'utf8')
  await fs.writeFile(path.join(buildOrdner, 'llms.txt'), llmsBauen(seo, eintraege), 'utf8')
  await fs.writeFile(path.join(buildOrdner, '404.html'), vierNullVierBauen(seo), 'utf8')

  // IndexNow: Bing & Co. verlangen eine Schlüsseldatei im Wurzelverzeichnis.
  // Astra-Fund 25 (16.10.): Der Schlüssel wird zum DATEINAMEN – nur die
  // von IndexNow erlaubte Form zulassen, sonst wäre ein Verzeichnis-Ausbruch
  // («../…») möglich.
  if (seo.site.indexNowKey && /^[A-Za-z0-9-]{8,128}$/.test(seo.site.indexNowKey)) {
    await fs.writeFile(path.join(buildOrdner, seo.site.indexNowKey + '.txt'), seo.site.indexNowKey, 'utf8')
  }

  const mitFaq = eintraege.filter(e => e.faqs?.length).length
  const ohneBeschreibung = eintraege.filter(e => !e.beschreibung && e.indexierbar !== false).length
  return {
    seitenAngereichert: angereichert,
    seitenGesamt: dateien.length,
    redirects: seo.redirects.length,
    mitFaq,
    ohneBeschreibung,
    analytics: analyticsSchnipsel(seo.site) ? seo.site.analyticsProvider : 'keins',
    erzeugt: ['sitemap.xml', 'robots.txt', '.htaccess', 'llms.txt', '404.html',
      ...(seo.site.indexNowKey ? [seo.site.indexNowKey + '.txt'] : [])],
  }
}
