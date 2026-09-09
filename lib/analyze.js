// Analyse eines importierten Projekts.
//
// Das ist das Herzstueck von Etappe 1: VinWeb liest den Export durch und sagt
// dir, was zwischen "Export aus Claude Design" und "kann live gehen" noch fehlt.

import fs from 'node:fs/promises'
import path from 'node:path'
import { quellPfad } from './projects.js'
// Zentrale Geheimnis-Muster – gepflegt in geheim.js (Review-Fund 5).
import { SCHLUESSEL_MUSTER as ZENTRAL } from './geheim.js'
import { GEHEIM_DATEINAME } from './geheim.js'

// Dateiendungen, deren Inhalt wir nach Verweisen durchsuchen.
const TEXT_ENDUNGEN = new Set(['.html', '.htm', '.css', '.js', '.php', '.json', '.md', '.txt', '.xml'])
const BILD_ENDUNGEN = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg'])
const VIDEO_ENDUNGEN = new Set(['.mp4', '.webm', '.mov', '.m4v'])

// Groesste Datei, die wir noch nach Text durchsuchen (4 MB).
const MAX_TEXT_BYTES = 4 * 1024 * 1024

// Hosts, die zwar in den Dateien stehen, aber nichts nachladen.
const HARMLOS = new Set(['www.w3.org', 'schema.org', 'www.schema.org'])

// Ordner, die typischerweise Arbeitsmaterial sind und nicht zur Website gehören.
const BALLAST = new Set(['uploads', 'scraps', 'node_modules', '.git', 'entwuerfe', 'drafts'])

// Dateinamen, die Zugangsdaten enthalten koennen.
const VERDAECHTIG = GEHEIM_DATEINAME   // zentral in lib/geheim.js

// Zugangsdaten verraten sich auch im Inhalt – unabhängig vom Dateinamen.
// Das ist der Fall, den ein Dateiname allein nicht abfängt: eine harmlos
// benannte Konfigurationsdatei, in der ein echter API-Schlüssel steht.
// Erfasst wird nur, WELCHE Art Schlüssel darin vorkommt – der Wert selbst
// wird nirgends ausgegeben und nirgends gespeichert.
const SCHLUESSEL_MUSTER = ZENTRAL.map(([name, regex]) => ({ name, regex }))

// ---------------------------------------------------------------------------
// Dateibaum einlesen
// ---------------------------------------------------------------------------

async function baumLesen (wurzel) {
  const dateien = []
  async function ab (ordner) {
    const eintraege = await fs.readdir(ordner, { withFileTypes: true })
    for (const e of eintraege) {
      // Der Git-Ordner ist die Buchhaltung des Verlaufs, nicht Teil der Website.
      if (e.name === '.git') continue
      const voll = path.join(ordner, e.name)
      if (e.isDirectory()) {
        await ab(voll)
      } else if (e.isFile()) {
        const stat = await fs.stat(voll)
        const rel = path.relative(wurzel, voll).split(path.sep).join('/')
        dateien.push({ rel, bytes: stat.size, ext: path.extname(e.name).toLowerCase() })
      }
    }
  }
  await ab(wurzel)
  dateien.sort((a, b) => a.rel.localeCompare(b.rel))
  return dateien
}

// ---------------------------------------------------------------------------
// Verweise aus einer Datei ziehen
// ---------------------------------------------------------------------------

function eingebundeneUrls (inhalt, ext) {
  const treffer = []
  const merke = (u) => { if (u) treffer.push(u.trim()) }

  if (ext === '.html' || ext === '.htm' || ext === '.php') {
    // Alles, was der Browser beim Laden der Seite selbst nachholt.
    for (const m of inhalt.matchAll(/\s(?:src|data-src|poster|data-poster)\s*=\s*["']([^"']+)["']/gi)) merke(m[1])
    for (const m of inhalt.matchAll(/<link\b[^>]*\shref\s*=\s*["']([^"']+)["'][^>]*>/gi)) merke(m[1])
    for (const m of inhalt.matchAll(/\ssrcset\s*=\s*["']([^"']+)["']/gi)) {
      for (const teil of m[1].split(',')) merke(teil.trim().split(/\s+/)[0])
    }
  }
  if (ext === '.css' || ext === '.html' || ext === '.htm') {
    for (const m of inhalt.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) merke(m[1])
    for (const m of inhalt.matchAll(/@import\s+["']([^"']+)["']/gi)) merke(m[1])
  }
  return treffer
}

function alleUrls (inhalt) {
  return [...inhalt.matchAll(/https?:\/\/[^\s"'`<>()\\]+/g)].map(m => m[0])
}

function hostVon (url) {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Hauptfunktion
// ---------------------------------------------------------------------------

export async function projektAnalysieren (id) {
  const wurzel = quellPfad(id)
  const dateien = await baumLesen(wurzel)
  const relSet = new Set(dateien.map(d => d.rel))

  const seiten = []
  const fremdRessourcen = new Map()   // host -> { count, dateien:Set }
  const nurVerlinkt = new Map()
  const sprachen = new Map()
  const erwaehnungen = new Map()   // 'seite.html' (klein) -> Anzahl Erwähnungen in ANDEREN Dateien
  const geheimImInhalt = new Map()   // rel -> [Art des Fundes]
  let seoConfig = null
  let hatHreflang = false
  const ohneTitel = []
  const ohneBeschreibung = []
  const editorReste = []   // Inhalt hinter </html> – Reste von Bearbeitungswerkzeugen

  for (const d of dateien) {
    if (!TEXT_ENDUNGEN.has(d.ext) || d.bytes > MAX_TEXT_BYTES) continue

    let inhalt
    try {
      inhalt = await fs.readFile(path.join(wurzel, d.rel), 'utf8')
    } catch {
      continue
    }

    // --- Zugangsdaten im Inhalt? ---
    const funde = SCHLUESSEL_MUSTER.filter(m => m.regex.test(inhalt)).map(m => m.name)
    if (funde.length) geheimImInhalt.set(d.rel, funde)

    // --- Konfiguration aus SiteSett erkannt? ---
    if (d.ext === '.json' && /sitesett/i.test(d.rel) && /"pages"|"site"/.test(inhalt)) {
      seoConfig = d.rel
    }

    // --- Erwähnungen für den Waisen-Check einsammeln ---
    // Jede Nennung eines .html-Dateinamens in einer ANDEREN Datei zählt als
    // eingehender Verweis (deckt href, JS-Daten und Fusszeilen-Skript ab).
    // NUR aus Seiten und Skripten – eine Erwähnung in Notizen (CLAUDE.md)
    // oder Arbeitsdaten ist keine Navigation.
    if (!['.html', '.htm', '.js'].includes(d.ext)) { /* keine Verweis-Quelle */ } else
    for (const m of inhalt.matchAll(/[\w][\w.-]*\.html?\b/gi)) {
      const name = m[0].toLowerCase()
      if (name === d.rel.toLowerCase().split('/').pop()) continue   // Selbstnennung zählt nicht
      erwaehnungen.set(name, (erwaehnungen.get(name) || 0) + 1)
    }

    // --- Seiten erfassen ---
    if (d.ext === '.html' || d.ext === '.htm') {
      const lang = (inhalt.match(/<html[^>]*\blang\s*=\s*["']([^"']+)["']/i) || [])[1] || null
      const titel = (inhalt.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || null
      const beschreibung = (inhalt.match(/<meta[^>]+name\s*=\s*["']description["'][^>]*>/i) || [])[0] || null

      seiten.push({
        rel: d.rel, bytes: d.bytes, lang, titel,
        // Ausdrückliche Markierung im Quelltext: diese Seite SOLL unverlinkt
        // sein (interne Doku, Landing für Kampagnen …) – der Waisen-Check
        // lässt sie dann in Ruhe.
        absichtlichUnverlinkt: inhalt.includes('vinweb:absichtlich-unverlinkt'),
      })
      const schluss = inhalt.toLowerCase().lastIndexOf('</html>')
      if (schluss >= 0 && inhalt.slice(schluss + 7).trim()) editorReste.push(d.rel)
      if (lang) sprachen.set(lang, (sprachen.get(lang) || 0) + 1)
      if (/hreflang\s*=/i.test(inhalt)) hatHreflang = true
      if (!titel) ohneTitel.push(d.rel)
      if (!beschreibung) ohneBeschreibung.push(d.rel)
    }

    // --- Verweise nach aussen ---
    const eingebunden = new Set(eingebundeneUrls(inhalt, d.ext).filter(u => /^https?:\/\//i.test(u)))
    for (const url of eingebunden) {
      const host = hostVon(url)
      if (!host || HARMLOS.has(host)) continue
      if (!fremdRessourcen.has(host)) fremdRessourcen.set(host, { anzahl: 0, dateien: new Set(), beispiele: new Set() })
      const e = fremdRessourcen.get(host)
      e.anzahl++
      e.dateien.add(d.rel)
      if (e.beispiele.size < 3) e.beispiele.add(url)
    }
    for (const url of alleUrls(inhalt)) {
      const host = hostVon(url)
      if (!host || HARMLOS.has(host) || fremdRessourcen.has(host)) continue
      if (!nurVerlinkt.has(host)) nurVerlinkt.set(host, 0)
      nurVerlinkt.set(host, nurVerlinkt.get(host) + 1)
    }
  }

  // -------------------------------------------------------------------------
  // Oberste Ebene: Was gehört ins Repo, was auf den Server?
  // -------------------------------------------------------------------------
  const obersteEbene = new Map()
  for (const d of dateien) {
    const kopf = d.rel.includes('/') ? d.rel.split('/')[0] : d.rel
    const istOrdner = d.rel.includes('/')
    if (!obersteEbene.has(kopf)) {
      obersteEbene.set(kopf, { name: kopf, istOrdner, dateien: 0, bytes: 0, inhalt: [] })
    }
    const e = obersteEbene.get(kopf)
    e.dateien++
    e.bytes += d.bytes
    e.inhalt.push(d.rel)
  }

  // Erkennt einen Unterordner, der die Wurzel spiegelt (z. B. export/).
  const spiegel = []
  for (const [name, e] of obersteEbene) {
    if (!e.istOrdner || e.dateien < 5) continue
    let treffer = 0
    for (const rel of e.inhalt) {
      const ohnePraefix = rel.slice(name.length + 1)
      if (relSet.has(ohnePraefix)) treffer++
    }
    const quote = treffer / e.dateien
    if (quote > 0.6) spiegel.push({ name, quote: Math.round(quote * 100), treffer, gesamt: e.dateien })
  }
  const spiegelNamen = new Set(spiegel.map(s => s.name))

  const struktur = [...obersteEbene.values()].map(e => {
    let repo = true
    let server = true
    let grund = 'Gehört zur Website'

    if (BALLAST.has(e.name.toLowerCase())) {
      repo = false; server = false; grund = 'Arbeitsmaterial – bleibt lokal'
    } else if (e.name.toLowerCase() === 'mobile') {
      repo = false; server = false; grund = 'Sieht nach Zwischenstand aus – bitte prüfen'
    } else if (spiegelNamen.has(e.name)) {
      repo = false; server = false; grund = 'Kopie der Wurzel – wird künftig neu erzeugt'
    } else if (/^\.(image-slots|scroll-shots)\.state\.json$/.test(e.name)) {
      // KEINE reinen Arbeitsdaten: Die Bild-Slots der Website lesen daraus
      // ihre Bilder. Ohne diese Dateien blieben die Slots live leer.
      repo = true; server = true; grund = 'Datenquelle der Bild-Slots – wird mitgeliefert'
    } else if (/^\..*\.state\.json$/.test(e.name) || /^\./.test(e.name)) {
      repo = true; server = false; grund = 'Arbeitsdaten des Editors – nicht öffentlich'
    } else if (/\.md$/i.test(e.name)) {
      repo = true; server = false; grund = 'Interne Notiz – nicht öffentlich'
    }

    // Zugangsdaten innerhalb des Ordners? Dann wird nicht der ganze Ordner
    // ausgeschlossen - nur die betroffenen Dateien. Der PHP-Code selbst gehört
    // sehr wohl ins Repo, nur die Datei mit den Schluesseln nicht.
    const geheim = e.inhalt.filter(r => VERDAECHTIG.test(r) || geheimImInhalt.has(r))
    if (geheim.length) {
      if (e.dateien === geheim.length) {
        repo = false
        grund = 'Zugangsdaten – niemals ins Repo'
      } else {
        grund = `Code ja – aber ${geheim.length} Datei(en) mit Zugangsdaten werden einzeln ausgeschlossen`
      }
    }

    return {
      name: e.name,
      istOrdner: e.istOrdner,
      dateien: e.dateien,
      bytes: e.bytes,
      repo,
      server,
      grund,
      zugangsdaten: geheim
    }
  }).sort((a, b) => b.bytes - a.bytes)

  // -------------------------------------------------------------------------
  // Befunde
  // -------------------------------------------------------------------------
  const befunde = []
  const b = (stufe, code, titel, text, liste = []) =>
    befunde.push({ stufe, code, titel, text, dateien: liste })

  // 1. Zugangsdaten
  const geheimAlle = dateien.filter(d => VERDAECHTIG.test(d.rel)).map(d => d.rel)
  if (geheimAlle.length) {
    b('fehler', 'zugangsdaten',
      `${geheimAlle.length} Datei(en) mit möglichen Zugangsdaten`,
      'Diese Dateien dürfen nie in ein Git-Repo - auch nicht in ein privates. VinWeb setzt sie beim Anlegen des Repos automatisch auf die Ausschlussliste.',
      geheimAlle)
  }

  // 1b. Zugangsdaten im Dateiinhalt – der gefährlichere Fall
  if (geheimImInhalt.size) {
    const liste = [...geheimImInhalt.entries()].map(([rel, arten]) => `${rel} — ${arten.join(', ')}`)
    b('fehler', 'zugangsdaten-inhalt',
      `${geheimImInhalt.size} Datei(en) enthalten einen echten Schlüssel`,
      'Diese Dateien heissen unauffällig, tragen aber Zugangsdaten im Inhalt. Genau so gelangen '
      + 'Schlüssel versehentlich in ein Repo. VinWeb schliesst sie automatisch aus. Der Wert selbst '
      + 'wird nirgends angezeigt und nirgends gespeichert.',
      liste)
  }

  // 1c. SEO-Konfiguration aus SiteSett gefunden
  if (seoConfig) {
    b('hinweis', 'seo-config',
      `SEO-Konfiguration gefunden: ${seoConfig}`,
      'VinWeb kann diese Datei in Etappe 3 übernehmen – Seitentitel, Beschreibungen, JSON-LD und '
      + 'Weiterleitungen müssen dann nicht neu erfasst werden. Ein darin gespeicherter '
      + 'API-Schlüssel wird beim Übernehmen entfernt.',
      [seoConfig])
  }

  // 2. Startseite
  if (!relSet.has('index.html')) {
    b('fehler', 'keine-startseite', 'Keine index.html im Hauptverzeichnis',
      'Ohne index.html zeigt der Server beim Aufruf der Domain nichts an. Beim Produktions-Build in Etappe 2 wird die Startseite entsprechend umbenannt.')
  }

  // 3. Fremde Ressourcen
  if (fremdRessourcen.size) {
    const liste = [...fremdRessourcen.entries()]
      .sort((a, b2) => b2[1].anzahl - a[1].anzahl)
      .map(([host, e]) => `${host} - ${e.anzahl}x in ${e.dateien.size} Datei(en)`)
    b('warnung', 'fremd-ressourcen',
      `${fremdRessourcen.size} fremde Quelle(n) werden beim Laden mitgeholt`,
      'Diese Adressen liefern Bilder, Schriften oder Skripte. Fällt eine davon aus oder aendert sich, ist deine Website betroffen. In Etappe 2 laedt VinWeb sie herunter und bindet sie örtlich ein.',
      liste)
  }

  // 4. Dateinamen
  const schlechteNamen = dateien
    .filter(d => d.ext === '.html' || d.ext === '.htm')
    .filter(d => /[ A-Z]|[^\x20-\x7e]/.test(path.basename(d.rel)))
    .map(d => d.rel)
  if (schlechteNamen.length) {
    b('warnung', 'dateinamen',
      `${schlechteNamen.length} Seite(n) mit ungeeignetem Dateinamen`,
      'Leerzeichen, Grossbuchstaben und Umlaute ergeben unschöne und fehleranfaellige Adressen. In Etappe 2 werden daraus saubere Kurznamen, samt Weiterleitung von alt nach neu.',
      schlechteNamen)
  }

  // 5. SEO-Grundausstattung
  const fehltSeo = ['robots.txt', 'sitemap.xml', '404.html'].filter(f => !relSet.has(f))
  if (fehltSeo.length) {
    b('warnung', 'seo-basis', `Es fehlen: ${fehltSeo.join(', ')}`,
      'Diese drei Dateien erzeugt VinWeb in Etappe 3 automatisch aus deinen Seiten.',
      fehltSeo)
  }

  // 6. Sprachen
  const sprachListe = [...sprachen.entries()].map(([s, n]) => `${s} (${n} Seiten)`)
  if (sprachen.size <= 1 && seiten.length > 1) {
    b('hinweis', 'sprachen',
      `Nur eine Sprache vorhanden: ${sprachListe.join(', ') || 'keine Angabe'}`,
      'Für eine zweite Sprache legt VinWeb in Etappe 3 die Ordnerstruktur an, uebersetzt Seite für Seite und trägt die Sprachverweise ein.',
      sprachListe)
  } else if (sprachen.size > 1 && !hatHreflang) {
    b('warnung', 'hreflang-fehlt',
      `${sprachen.size} Sprachen, aber keine Sprachverweise (hreflang)`,
      'Ohne hreflang weiss Google nicht, dass die Seiten zusammengehoeren, und zeigt Besuchern womöglich die falsche Sprache.',
      sprachListe)
  }

  // 7. Doppelter Baum
  for (const s of spiegel) {
    b('warnung', 'doppelter-baum',
      `Ordner "${s.name}" ist eine Kopie der Wurzel (${s.quote}% Übereinstimmung)`,
      'Zwei Stände derselben Website nebeneinander sind eine Fehlerquelle – man deployt leicht den falschen. Künftig erzeugt VinWeb diesen Stand bei jedem Build neu.',
      [`${s.treffer} von ${s.gesamt} Dateien gibt es auch in der Wurzel`])
  }

  // 7b. Editor-Reste hinter dem Dokumentende
  if (editorReste.length) {
    b('warnung', 'editor-reste',
      `${editorReste.length} Seite(n) mit Inhalt nach </html>`,
      'Reste von Bearbeitungswerkzeugen ausserhalb des Dokuments. Der Produktions-Build '
      + 'entfernt sie automatisch – die Klick-Editoren für Bilder bleiben davon unberührt.',
      editorReste)
  }

  // 8. Schwere Medien
  const schwer = dateien
    .filter(d => (BILD_ENDUNGEN.has(d.ext) || VIDEO_ENDUNGEN.has(d.ext)) && d.bytes > 500 * 1024)
    .sort((a, b2) => b2.bytes - a.bytes)
    .map(d => `${d.rel} - ${(d.bytes / 1024 / 1024).toFixed(1)} MB`)
  if (schwer.length) {
    b('warnung', 'schwere-medien', `${schwer.length} Datei(en) über 500 KB`,
      'Grosse Bilder sind der häufigste Grund für langsame Seiten. Etappe 2 rechnet sie in moderne Formate und passende Grössen um.',
      schwer.slice(0, 15))
  }

  // 8b. Waisenseiten: existieren, sind aber nirgends verlinkt
  const waisen = seiten
    .filter(s => !s.rel.includes('/'))
    .filter(s => s.rel.toLowerCase() !== 'index.html')
    .filter(s => !s.absichtlichUnverlinkt)
    .filter(s => !erwaehnungen.has(s.rel.toLowerCase()))
    .map(s => s.rel)
  if (waisen.length) {
    b('warnung', 'waisen', `${waisen.length} Seite(n) nirgends verlinkt`,
      'Diese Seiten existieren, aber keine andere Seite (auch nicht Fusszeile oder '
      + 'Übersichten) verweist auf sie. Besucher finden sie nur mit der exakten Adresse, '
      + 'und Google stuft unverlinkte Seiten zurück. Entweder verlinken – oder löschen, '
      + 'falls sie nicht mehr gebraucht werden.',
      waisen)
  }

  // 9. Fehlende Seitentitel und Beschreibungen
  if (ohneTitel.length) {
    b('warnung', 'titel-fehlt', `${ohneTitel.length} Seite(n) ohne Titel`,
      'Der Titel ist das, was in der Google-Trefferliste als blaue Zeile erscheint.', ohneTitel)
  }
  if (ohneBeschreibung.length) {
    b('hinweis', 'beschreibung-fehlt', `${ohneBeschreibung.length} Seite(n) ohne Meta-Beschreibung`,
      'Ohne eigene Beschreibung sucht sich Google selbst einen Textausschnitt aus der Seite.', ohneBeschreibung)
  }

  const reihenfolge = { fehler: 0, warnung: 1, hinweis: 2 }
  befunde.sort((a, c) => reihenfolge[a.stufe] - reihenfolge[c.stufe])

  return {
    erstelltAm: new Date().toISOString(),
    summe: {
      dateien: dateien.length,
      bytes: dateien.reduce((s, d) => s + d.bytes, 0),
      seiten: seiten.length,
      bilder: dateien.filter(d => BILD_ENDUNGEN.has(d.ext)).length,
      videos: dateien.filter(d => VIDEO_ENDUNGEN.has(d.ext)).length
    },
    seiten: seiten.sort((a, c) => a.rel.localeCompare(c.rel)),
    struktur,
    befunde,
    fremdeHosts: [...fremdRessourcen.entries()].map(([host, e]) => ({
      host, anzahl: e.anzahl, dateien: [...e.dateien], beispiele: [...e.beispiele]
    })).sort((a, c) => c.anzahl - a.anzahl),
    nurVerlinkteHosts: [...nurVerlinkt.entries()]
      .map(([host, n]) => ({ host, anzahl: n }))
      .sort((a, c) => c.anzahl - a.anzahl)
  }
}
