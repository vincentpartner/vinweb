// KI-Endprüfung: der letzte Blick vor dem Go-Live.
//
// Geprüft wird der BUILD – denn der geht live, nicht die Quelle.
// Zwei Schichten:
//   1. Mechanisch (ohne KI, deterministisch): kaputte Verweise, doppelte
//      Meta-Angaben, Sitemap-Lücken, Zugangsdaten, fremde Quellen.
//   2. KI (Modell frei wählbar): Code-Fehler und Redundanz, Sicherheit
//      (v. a. PHP), und ob die SEO-Angaben aus SiteSett inhaltlich Sinn ergeben.
//
// Ergebnis: ein Bericht mit Funden (kritisch / warnung / hinweis), gespeichert
// in projekt.json samt Verlaufs-Stand – ändert sich die Quelle danach, gilt
// die Prüfung als veraltet und der Schritt auf der Startseite kippt zurück.

import fs from 'node:fs/promises'
import path from 'node:path'
import { buildPfad } from './build.js'
import { chatStreamen } from './ai.js'
import { verlauf, istRepo } from './git.js'

const TEXTE = new Set(['.html', '.htm', '.css', '.js', '.php', '.txt', '.xml', '.json'])

import { SCHLUESSEL_MUSTER, geheimnisImInhalt } from './geheim.js'

async function alleDateien (wurzel) {
  const raus = []
  async function ab (ordner) {
    for (const e of await fs.readdir(ordner, { withFileTypes: true })) {
      const voll = path.join(ordner, e.name)
      if (e.isDirectory()) await ab(voll)
      else raus.push(path.relative(wurzel, voll).split(path.sep).join('/'))
    }
  }
  await ab(wurzel)
  return raus
}

// ---------------------------------------------------------------------------
// Schicht 1: mechanische Prüfungen
// ---------------------------------------------------------------------------

export async function mechanischPruefen (ordner) {
  const funde = []
  const f = (schwere, kategorie, datei, titel, text) =>
    funde.push({ schwere, kategorie, datei, titel, text, quelle: 'mechanisch' })

  const dateien = await alleDateien(ordner)
  const vorhanden = new Set(dateien)
  const htmls = dateien.filter(d => /\.html?$/i.test(d))

  for (const rel of htmls) {
    const inhalt = await fs.readFile(path.join(ordner, rel), 'utf8')

    // Kaputte örtliche Verweise
    for (const m of inhalt.matchAll(/(?:src|href|poster)="([^"]+)"/g)) {
      let ziel = m[1]
      if (/^(https?:|mailto:|tel:|#|data:|javascript:)/i.test(ziel) || !ziel || ziel === '/') continue
      if (/[\s'"+]/.test(ziel)) continue   // JavaScript-Baustein, kein statischer Verweis
      ziel = decodeURIComponent(ziel.split('?')[0].split('#')[0]).replace(/^\.\//, '').replace(/^\//, '')
      if (!ziel) continue
      const voll = path.posix.normalize(path.posix.join(path.posix.dirname(rel), ziel))
      const alsWurzel = path.posix.normalize(ziel)
      // Saubere Adressen: /kontakt gilt als gefunden, wenn kontakt.html existiert.
      const kandidaten = [voll, alsWurzel, voll + '.html', alsWurzel + '.html']
      if (!kandidaten.some(k => vorhanden.has(k))) {
        f('kritisch', 'technik', rel, 'Kaputter Verweis', `"${m[1]}" zeigt auf eine Datei, die es im Build nicht gibt.`)
      }
    }

    // Doppelte Kopf-Angaben
    const anz = (re) => (inhalt.match(re) || []).length
    if (anz(/<title[\s>]/gi) > 1) f('kritisch', 'seo', rel, 'Doppelter <title>', 'Mehr als ein Titel-Tag – Google wählt dann selbst.')
    if (anz(/<meta[^>]+name\s*=\s*["']description["']/gi) > 1) f('warnung', 'seo', rel, 'Doppelte Beschreibung', 'Mehr als eine Meta-Description im Kopf.')
    if (anz(/<link[^>]+rel\s*=\s*["']canonical["']/gi) > 1) f('kritisch', 'seo', rel, 'Doppeltes Canonical', 'Widersprüchliche Canonical-Angaben verwirren Google nachhaltig.')
    if (anz(/<html[\s>]/gi) > 1 || /<\/html>[\s\S]*?\S/.test(inhalt.split(/<\/html>/i).slice(1).join(''))) {
      f('warnung', 'technik', rel, 'Inhalt nach </html>', 'Nach dem Dokumentende steht noch Text – Editor-Reste?')
    }

    // Bilder ohne Alt-Text
    const ohneAlt = (inhalt.match(/<img(?![^>]*\balt\s*=)[^>]*>/gi) || []).length
    if (ohneAlt) f('hinweis', 'seo', rel, ohneAlt + ' Bild(er) ohne Alt-Text', 'Alt-Texte helfen Google und Menschen mit Screenreader.')

    // Fremde eingebundene Quellen
    for (const m of inhalt.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) {
      const url = m[1]
      if (/\.(js|css|woff2?|jpe?g|png|webp|gif|svg)(\?|$)/i.test(url) && !/schema\.org|w3\.org/.test(url)) {
        f('warnung', 'technik', rel, 'Fremde Quelle wird mitgeladen', url.slice(0, 90))
      }
    }
  }

  // Zugangsdaten im Build?
  for (const rel of dateien) {
    if (!TEXTE.has(path.extname(rel).toLowerCase())) continue
    const inhalt = await fs.readFile(path.join(ordner, rel), 'utf8').catch(() => '')
    for (const [name, re] of SCHLUESSEL_MUSTER) {
      if (re.test(inhalt)) f('kritisch', 'sicherheit', rel, name + ' im Build!', 'Diese Datei würde den Schlüssel öffentlich machen – vor dem Go-Live entfernen.')
    }
  }

  // Grundausstattung + Sitemap-Konsistenz
  for (const noetig of ['robots.txt', 'sitemap.xml', '404.html', '.htaccess']) {
    if (!vorhanden.has(noetig)) f('warnung', 'seo', noetig, 'Fehlt im Build', 'Wird von Etappe 3 normalerweise erzeugt – Build neu erstellen?')
  }
  if (vorhanden.has('sitemap.xml')) {
    const sm = await fs.readFile(path.join(ordner, 'sitemap.xml'), 'utf8')
    for (const m of sm.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
      try {
        const pfad = decodeURIComponent(new URL(m[1]).pathname).replace(/^\//, '') || 'index.html'
        if (!vorhanden.has(pfad) && !vorhanden.has(pfad + '.html')) {
          f('kritisch', 'seo', 'sitemap.xml', 'Sitemap verweist ins Leere', m[1])
        }
      } catch { f('warnung', 'seo', 'sitemap.xml', 'Unlesbare Adresse', m[1].slice(0, 80)) }
    }
  }

  // Weiterleitungsziele
  if (vorhanden.has('.htaccess')) {
    const ht = await fs.readFile(path.join(ordner, '.htaccess'), 'utf8')
    for (const m of ht.matchAll(/^Redirect\s+301\s+(\S+)\s+(\S+)/gm)) {
      const ziel = m[2].replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '')
      if (ziel && !/^https?:/.test(m[2]) === false) continue
      if (ziel && !vorhanden.has(ziel) && !vorhanden.has(ziel + '.html') && ziel !== '') {
        f('warnung', 'seo', '.htaccess', 'Weiterleitung ins Leere', `${m[1]} → ${m[2]}`)
      }
    }
  }

  // Schwergewichte
  for (const rel of dateien) {
    const groesse = (await fs.stat(path.join(ordner, rel))).size
    if (groesse > 800 * 1024 && /\.(jpe?g|png|webp|gif)$/i.test(rel)) {
      f('hinweis', 'technik', rel, Math.round(groesse / 1024) + ' KB', 'Ungewöhnlich gross – bremst die Seite.')
    }
  }

  return funde
}

// ---------------------------------------------------------------------------
// Schicht 2: KI-Prüfung
// ---------------------------------------------------------------------------

const ANTWORT_REGEL = `Antworte AUSSCHLIESSLICH mit einem JSON-Objekt dieser Form, ohne Text davor oder danach:
{"funde":[{"schwere":"kritisch|warnung|hinweis","kategorie":"bug|redundanz|sicherheit|seo","datei":"pfad","titel":"kurz","text":"was und warum, 1-3 Sätze","empfehlung":"was tun, 1 Satz"}]}
Nur echte Funde melden – kein Fund ist ein gutes Ergebnis. Keine Stilkritik, keine Geschmacksfragen.
Schweizer Hochdeutsch (ss statt ß).`

async function dateiBlock (ordner, rel, maxKb = 24) {
  try {
    const inhalt = await fs.readFile(path.join(ordner, rel), 'utf8')
    if (inhalt.length > maxKb * 1024) return `--- ${rel} (übersprungen, ${Math.round(inhalt.length / 1024)} KB) ---`
    // Review-Fund 5: Dateien mit Geheimnis-Inhalt gehen NIE zur KI.
    const fund = geheimnisImInhalt(inhalt)
    if (fund) return `--- ${rel} (ausgelassen: enthält ${fund}) ---`
    return `--- ${rel} ---\n${inhalt}`
  } catch { return '' }
}

export async function endpruefungLaufen ({ projekt, anbieter, modell, onMeldung = () => {}, signal }) {
  const ordner = buildPfad(projekt.id)
  try { await fs.access(ordner) } catch {
    throw new Error('Es gibt noch keinen Build – bitte zuerst unter «Build» erzeugen. Geprüft wird, was live geht.')
  }

  onMeldung('Mechanische Prüfung läuft …')
  const funde = await mechanischPruefen(ordner)
  onMeldung(`Mechanisch: ${funde.length} Fund(e). Stelle KI-Kontext zusammen …`)

  const dateien = await alleDateien(ordner)
  let verbrauch = { ein: 0, aus: 0 }
  let unvollstaendig = 0   // Review-Fund 19: unbrauchbare KI-Antworten zählen
  const kiAufruf = async (name, system, inhalt) => {
    if (signal?.aborted) throw new Error('Prüfung abgebrochen.')
    onMeldung(`KI prüft: ${name} …`)
    const r = await chatStreamen({
      anbieter, modell, signal,
      system: system + '\n\n' + ANTWORT_REGEL,
      nachrichten: [{ rolle: 'user', text: inhalt }],
    })
    if (r.verbrauch) { verbrauch.ein += r.verbrauch.ein || 0; verbrauch.aus += r.verbrauch.aus || 0 }
    const m = r.text.match(/\{[\s\S]*\}/)
    if (!m) { unvollstaendig++; onMeldung(`⚠ ${name}: Antwort unbrauchbar – Prüfung zählt nicht als bestanden.`); return [] }
    try {
      return (JSON.parse(m[0]).funde || []).map(x => ({
        schwere: ['kritisch', 'warnung', 'hinweis'].includes(x.schwere) ? x.schwere : 'hinweis',
        kategorie: x.kategorie || 'bug',
        datei: String(x.datei || '').slice(0, 200),
        titel: String(x.titel || '').slice(0, 120),
        text: String(x.text || '').slice(0, 600),
        empfehlung: String(x.empfehlung || '').slice(0, 300),
        quelle: 'ki',
      }))
    } catch { unvollstaendig++; onMeldung(`⚠ ${name}: Antwort war kein gültiges JSON.`); return [] }
  }

  // --- Aufruf 1: Code & Sicherheit ---
  const codeDateien = dateien.filter(d =>
    (/^assets\/.*\.js$/.test(d) || /^kalender\/.*\.php$/.test(d) || d === '.htaccess'))
  const codeBloecke = []
  for (const d of codeDateien) codeBloecke.push(await dateiBlock(ordner, d))
  const fundeCode = await kiAufruf('Code & Sicherheit',
    'Du prüfst den Produktions-Build einer statischen Website (mit kleinem PHP-Backend für Terminbuchung) '
    + 'kurz vor dem Livegang. Suche: (1) echte Fehler im JavaScript, (2) klar redundanten oder toten Code, '
    + '(3) Sicherheitslücken, besonders im PHP (Injection, fehlende Prüfung von Eingaben, offene Endpunkte, '
    + 'Ratenbegrenzung, Preisgabe von Interna) und in der .htaccess. Melde nur, was du am Code belegen kannst. '
    + 'Zum Kontext: kalender/config.php fehlt hier ABSICHTLICH – sie enthält Zugangsdaten, liegt nie im Repo '
    + 'und wird beim Livegang separat auf den Server gelegt. Ihr Fehlen ist kein Fund. '
    + 'Ebenfalls kein Fund: Die .htaccess wird vom Build-Werkzeug generiert – melde dort nur konkrete '
    + 'Fehler in vorhandenen Regeln, keine allgemeinen Wünsche an die Serverkonfiguration '
    + '(Ratenbegrenzung gehört auf Shared Hosting in den PHP-Code).',
    codeBloecke.filter(Boolean).join('\n\n'))

  // --- Aufruf 2: SEO-Sinnhaftigkeit ---
  const seo = projekt.seo || {}
  const seoTabelle = Object.entries(seo.pages || {}).map(([datei, p]) =>
    `${datei} | indexierbar:${p.indexierbar !== false} | Titel: ${p.titel || '(leer)'} | Beschreibung: ${p.beschreibung || '(leer)'}${p.faqs?.length ? ' | FAQs: ' + p.faqs.length : ''}`)
  const koepfe = []
  for (const rel of ['index.html', 'about.html', 'kontakt.html'].filter(r => dateien.includes(r))) {
    const inhalt = await fs.readFile(path.join(ordner, rel), 'utf8')
    const kopf = inhalt.match(/<head[\s\S]*?<\/head>/i)?.[0] || ''
    koepfe.push(`--- <head> von ${rel} ---\n${kopf.slice(0, 8000)}`)
  }
  const fundeSeo = await kiAufruf('SEO-Einstellungen',
    'Du prüfst die SEO-Konfiguration einer Schweizer Firmenwebsite kurz vor dem Livegang. '
    + 'Beurteile, ob Titel und Beschreibungen inhaltlich Sinn ergeben (Länge, Suchintention, keine Duplikate '
    + 'über Seiten hinweg, keine Platzhalter oder Testtexte), ob die JSON-LD-Blöcke in den Kopf-Auszügen '
    + 'in sich stimmig sind (Adressen, Telefonnummern, URLs konsistent) und ob Auffälligkeiten in '
    + 'sitemap/robots bestehen. Melde nur konkrete Probleme, keine Allgemeinplätze.',
    `SITE-PROFIL:\n${JSON.stringify(seo.site || {}, null, 1)}\n\nSEITEN:\n${seoTabelle.join('\n')}\n\n${koepfe.join('\n\n')}`)

  funde.push(...fundeCode, ...fundeSeo)

  // Review-Fund 18: Massgeblich ist der Fingerabdruck des GEPRÜFTEN Builds –
  // nicht der Git-Hash der Quelle bei Prüfungsende.
  const buildAbdruck = await buildFingerabdruck(ordner)
  let stand = null
  try { if (await istRepo(projekt.id)) stand = (await verlauf(projekt.id))[0]?.hash || null } catch {}

  const statistik = {
    kritisch: funde.filter(x => x.schwere === 'kritisch').length,
    warnung: funde.filter(x => x.schwere === 'warnung').length,
    hinweis: funde.filter(x => x.schwere === 'hinweis').length,
  }
  return {
    am: new Date().toISOString(),
    stand, buildAbdruck, anbieter, modell,
    funde, statistik, verbrauch,
    unvollstaendig: unvollstaendig > 0,
  }
}

// Fingerabdruck eines Build-Ordners: Pfade, Grössen und Änderungszeiten.
// Ändert sich irgendetwas am Build, ändert sich der Abdruck.
export async function buildFingerabdruck (ordner) {
  const crypto = await import('node:crypto')
  const dateien = await alleDateien(ordner)
  const h = crypto.createHash('sha1')
  for (const rel of dateien.sort()) {
    const st = await fs.stat(path.join(ordner, rel))
    h.update(rel + '|' + st.size + '|' + Math.round(st.mtimeMs) + '\n')
  }
  return h.digest('hex')
}
