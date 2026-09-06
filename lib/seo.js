// Etappe 3 (Vollausbau) – SEO.
//
// Arbeitsteilung mit dem Schwesterwerkzeug SiteSett:
//   SiteSett  = der Redaktionsplatz für die SEO-DETAILARBEIT
//               (FAQs, Schema-Typen, OG-Bilder, Analytics, Verifizierung …)
//   VinWeb    = übernimmt dessen Config VOLLSTÄNDIG und prägt sie beim
//               Produktions-Build in die Seiten ein.
//
// Grundsatz: SEO wird NIE in die Quelle geschrieben, nur in den Build.
// Einzige Ausnahme: BILDER aus der SiteSett-Config (OG-Bilder, Favicon) –
// das sind Inhalte, keine Metadaten. Sie werden beim Import als echte
// Dateien in die Quelle gelegt, damit Verweise darauf überall funktionieren.

import fs from 'node:fs/promises'
import path from 'node:path'
import { zuSlug } from './build.js'

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
//   - Seiten, die nur im bestehenden Stand existieren (z. B. in VinWeb neu
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
  return basis + '/' + rel.replace(/\.html?$/i, '')
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
      return seite.jsonldEigen
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
    inLanguage: seo.site.sprache,
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
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2)
}

// ---------------------------------------------------------------------------
// Analytics-Schnipsel (nur wenn in SiteSett eingerichtet)
// ---------------------------------------------------------------------------

function analyticsSchnipsel (site) {
  if (site.analyticsProvider === 'ga4' && site.analyticsId) {
    const id = esc(site.analyticsId)
    return `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>\n`
      + `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');</script>`
  }
  if (site.analyticsProvider === 'matomo' && site.matomoUrl && site.analyticsId) {
    const u = String(site.matomoUrl).replace(/\/+$/, '')
    return '<script>var _paq=window._paq=window._paq||[];_paq.push(["trackPageView"]);_paq.push(["enableLinkTracking"]);'
      + `(function(){var u="${u}/";_paq.push(["setTrackerUrl",u+"matomo.php"]);_paq.push(["setSiteId","${esc(site.analyticsId)}"]);`
      + 'var d=document,g=d.createElement("script"),s=d.getElementsByTagName("script")[0];g.async=true;g.src=u+"matomo.js";s.parentNode.insertBefore(g,s);})();</script>'
  }
  return ''
}

// ---------------------------------------------------------------------------
// Eine HTML-Datei anreichern
// ---------------------------------------------------------------------------

const MARKE_START = '<!-- vinweb-seo -->'
const MARKE_ENDE = '<!-- /vinweb-seo -->'
const BODY_START = '<!-- vinweb-seo-body -->'
const BODY_ENDE = '<!-- /vinweb-seo-body -->'

export function htmlAnreichern (html, seo, rel, seite) {
  // Frühere VinWeb-Blöcke entfernen – so bleibt das Ganze wiederholbar.
  html = html.replace(new RegExp(MARKE_START + '[\\s\\S]*?' + MARKE_ENDE + '\\n?', 'g'), '')
  html = html.replace(new RegExp(BODY_START + '[\\s\\S]*?' + BODY_ENDE + '\\n?', 'g'), '')

  // Title und Meta-Description AN ORT UND STELLE ersetzen (nie doppelt).
  const titel = seite.titel || seo.site.name
  if (titel) {
    if (/<title[^>]*>[\s\S]*?<\/title>/i.test(html)) {
      html = html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, '<title>' + esc(titel) + '</title>')
    } else {
      html = html.replace(/<head([^>]*)>/i, '<head$1>\n<title>' + esc(titel) + '</title>')
    }
  }
  const beschreibung = seite.beschreibung || ''
  if (beschreibung) {
    const meta = '<meta name="description" content="' + esc(beschreibung) + '">'
    if (/<meta[^>]+name\s*=\s*["']description["'][^>]*>/i.test(html)) {
      html = html.replace(/<meta[^>]+name\s*=\s*["']description["'][^>]*>/i, meta)
    } else {
      html = html.replace(/<\/title>/i, '</title>\n' + meta)
    }
  }

  const url = absUrl(seo.site.domain, rel)
  const istStart = rel === 'index.html'
  const og = absBild(seo.site.domain, seite.ogBild || seo.site.ogBild)
  const analytics = analyticsSchnipsel(seo.site)

  const kopf = [
    MARKE_START,
    `<link rel="canonical" href="${esc(url)}">`,
    seite.indexierbar === false ? '<meta name="robots" content="noindex, nofollow">' : null,
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
    `<meta property="og:title" content="${esc(seite.ogTitel || titel)}">`,
    (seite.ogBeschreibung || beschreibung)
      ? `<meta property="og:description" content="${esc(seite.ogBeschreibung || beschreibung)}">` : null,
    og ? `<meta property="og:image" content="${esc(og)}">` : null,
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

  html = html.replace(/<\/head>/i, kopf.join('\n') + '\n</head>')

  // Direkt nach <body> (Tag-Manager-noscript u. Ä. aus SiteSett).
  if (seo.site.globalBodyTop) {
    html = html.replace(/<body([^>]*)>/i,
      '<body$1>\n' + BODY_START + '\n' + seo.site.globalBodyTop + '\n' + BODY_ENDE)
  }
  return html
}

// ---------------------------------------------------------------------------
// Begleitdateien
// ---------------------------------------------------------------------------

export function sitemapBauen (seo, eintraege) {
  const heute = new Date().toISOString().slice(0, 10)
  const urls = eintraege
    .filter(e => e.indexierbar !== false)
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
    '# Von VinWeb erzeugt – Änderungen hier gehen beim nächsten Build verloren.',
    '',
    'AddDefaultCharset UTF-8',
    'ErrorDocument 404 /404.html',
    '',
    '# Saubere Adressen: /kontakt statt /kontakt.html',
    'Options -MultiViews',
    '<IfModule mod_rewrite.c>',
    '  RewriteEngine On',
    '  # Startseite hat genau EINE Adresse: /',
    '  RewriteRule ^index\\.html$ / [R=301,L]',
    '  RewriteRule ^index$ / [R=301,L]',
    '  # Alte .html-Adressen dauerhaft auf die saubere Form umleiten',
    '  RewriteCond %{THE_REQUEST} \\s/([^\\s?]+)\\.html[\\s?]',
    '  RewriteRule ^ /%1 [R=301,L]',
    '  # Saubere Adresse intern auf die Datei abbilden',
    '  RewriteCond %{REQUEST_FILENAME} !-d',
    '  RewriteCond %{REQUEST_FILENAME}.html -f',
    '  RewriteRule ^(.*)$ $1.html [L]',
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
    for (const r of seo.redirects) zeilen.push(`Redirect 301 ${r.von} ${r.nach}`)
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
<link rel="stylesheet" href="/assets/swiss.css">
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
  for (const quelle of Object.keys(seo.pages)) buildName.set(zuSlug(quelle), seo.pages[quelle])

  const dateien = (await fs.readdir(buildOrdner)).filter(f => /\.html?$/i.test(f) && f !== '404.html')
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
  if (seo.site.indexNowKey) {
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
