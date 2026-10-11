// Seitentypen fuer Sitepilot Midi (Etappe 5, Entscheid 11.10.2026).
//
// Hier legt die Agentur pro Website fest, wo neue Kundenseiten automatisch
// erscheinen. Je Seitentyp eine MUSTERSEITE, die schon richtig eingehaengt
// ist: Ueberall, wo sie als Listeneintrag verlinkt ist (Dropdown, Handy-
// Menue, Footer, Uebersicht), traegt Midi neue Seiten dieses Typs ein.
//
//   aktuelles   Aktuelles / Blog   -> Uebersicht, nach Datum (neuste zuerst)
//   leistung    Dienstleistung     -> Unterpunkt im Menue, Footer, Uebersicht
//   landingpage Kampagnenseite     -> nur Footer
//
// Hauptmenuepunkte legt nur die Agentur an - Listen, die auch die Startseite
// enthalten, nimmt Midi nie.
//
// Ablage: source/.sitepilot/seitentypen.json (im Repo, nie auf dem Server).
//
// Die ERKENNUNG der Listeneintraege ist wortgleich zu Midis lib/verlinkung.js
// (vorfahren, hrefPasst, bereichVon, vorkommenFinden) - Aenderungen in beiden
// Apps nachziehen, sonst zeigt dieses Panel andere Stellen als Midi befuellt.

import fs from 'node:fs/promises'
import path from 'node:path'
import { quellPfad, projektPfad } from './projects.js'
import { elementAb, kinderFinden, blindKopie, sichtbarerText } from './bausteine.js'

export const TYPEN = [
  { id: 'aktuelles', name: 'Aktuelles / Blog', bereiche: ['inhalt'], position: 'datum' },
  { id: 'leistung', name: 'Dienstleistung', bereiche: ['navigation', 'footer', 'inhalt'], position: 'ende' },
  { id: 'landingpage', name: 'Kampagnenseite', bereiche: ['footer'], position: 'ende' },
]
const BEREICHE = ['navigation', 'footer', 'inhalt']
const OHNE_ENDE = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source',
  'track', 'wbr', 'area', 'base', 'col', 'embed', 'param'])

function datei (id, name) {
  return path.join(quellPfad(id), '.sitepilot', name)
}

// Wie Midis metaDatei(): liegt die Datei nur am alten Ort (Projektordner),
// wird sie einmalig nach innen geholt - sonst legte die Agentur ein leeres
// Seitenbuch an und Midi faende den alten Bestand nie mehr (Astra-Fund 11.10.).
async function metaDatei (id, name) {
  const neu = datei(id, name)
  try { await fs.access(neu); return neu } catch { /* noch nicht migriert */ }
  try {
    const alt = path.join(projektPfad(id), name)
    const inhalt = await fs.readFile(alt, 'utf8')
    await fs.mkdir(path.dirname(neu), { recursive: true })
    await fs.writeFile(neu, inhalt, 'utf8')
    await fs.rename(alt, alt + '.migriert')
  } catch { /* auch alt nichts */ }
  return neu
}

async function jsonLesen (voll, leer) {
  let text
  try { text = await fs.readFile(voll, 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return leer
    throw e
  }
  return JSON.parse(text)   // beschaedigt = Fehler, nie still leer
}

async function jsonSchreiben (voll, daten) {
  await fs.mkdir(path.dirname(voll), { recursive: true })
  const tmp = voll + '.agentur.tmp'   // nie dieselbe Zwischendatei wie Midi
  await fs.writeFile(tmp, JSON.stringify(daten, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, voll)
}

// Konfiguration lesen - immer alle drei Typen (nicht eingerichtete als inaktiv).
export async function seitentypenLesen (id) {
  const roh = await jsonLesen(datei(id, 'seitentypen.json'), { typen: [] })
  const gespeichert = Array.isArray(roh?.typen) ? roh.typen : []
  const mini = await jsonLesen(await metaDatei(id, 'mini.json'), {})
  const vorlagen = Array.isArray(mini?.vorlagen) ? mini.vorlagen : []
  return TYPEN.map(t => {
    const g = gespeichert.find(x => x?.id === t.id) || {}
    return {
      ...t,
      aktiv: !!g.muster && g.aktiv !== false,
      muster: g.muster || '',
      bereiche: Array.isArray(g.bereiche) ? g.bereiche.filter(b => BEREICHE.includes(b)) : t.bereiche,
      max: Number.isInteger(g.max) && g.max > 0 ? g.max : null,
      alsVorlage: vorlagen.some(v => v?.typ === t.id && v?.seite === g.muster),
    }
  })
}

// Speichern. Optional wird die Musterseite in mini.json auch als Vorlage
// fuer «Aus Vorlage kopieren» eingetragen (mit typ - dann haengt auch Mini
// neue Seiten richtig ein).
export async function seitentypenSchreiben (id, eingabe, seiten) {
  const typen = []
  for (const t of TYPEN) {
    const e = (Array.isArray(eingabe) ? eingabe : []).find(x => x?.id === t.id) || {}
    const muster = typeof e.muster === 'string' ? e.muster : ''
    if (muster && !seiten.includes(muster)) throw new Error(`Musterseite «${muster}» gibt es nicht.`)
    const bereiche = (Array.isArray(e.bereiche) ? e.bereiche : t.bereiche).filter(b => BEREICHE.includes(b))
    if (e.aktiv && muster && !bereiche.length) throw new Error(`«${t.name}»: bitte mindestens einen Bereich wählen.`)
    typen.push({
      id: t.id,
      aktiv: !!e.aktiv && !!muster,
      muster,
      bereiche,
      max: Number.isInteger(e.max) && e.max > 0 && e.max < 100 ? e.max : null,
      alsVorlage: !!e.alsVorlage,
    })
  }
  await jsonSchreiben(datei(id, 'seitentypen.json'), {
    typen: typen.filter(t => t.muster).map(({ alsVorlage, ...rest }) => rest),
  })

  // Vorlagen in mini.json nachfuehren (nur die Typ-Vorlagen anfassen).
  const miniDatei = await metaDatei(id, 'mini.json')
  const mini = await jsonLesen(miniDatei, { vorlagen: [], erstellt: [], geloescht: [], postUrsprung: {} })
  let vorlagen = (Array.isArray(mini.vorlagen) ? mini.vorlagen : []).filter(v => !v?.typ)
  for (const t of typen) {
    if (t.aktiv && t.alsVorlage) {
      vorlagen = vorlagen.filter(v => v.seite !== t.muster)
      vorlagen.push({ seite: t.muster, name: TYPEN.find(x => x.id === t.id).name, typ: t.id })
    }
  }
  mini.vorlagen = vorlagen
  await jsonSchreiben(miniDatei, mini)
}

// ---------------------------------------------------------------------------
// Erkennung (wortgleich zu Midi lib/verlinkung.js)
// ---------------------------------------------------------------------------

function vorfahren (blind, bis) {
  const stapel = []
  const muster = /<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g
  let m
  while ((m = muster.exec(blind)) !== null && m.index < bis) {
    const tag = m[2].toLowerCase()
    if (m[1]) {
      const i = stapel.map(s => s.tag).lastIndexOf(tag)
      if (i >= 0) stapel.length = i
    } else if (!m[3] && !OHNE_ENDE.has(tag)) {
      stapel.push({ tag, start: m.index, kopf: m[0] })
    }
  }
  return stapel
}

function hrefZiel (kopf, seitenPfad) {
  const h = (kopf.match(/\bhref\s*=\s*["']([^"'#?]*)/i) || [])[1]
  if (!h || /^[a-z]+:/i.test(h)) return null
  if (h.startsWith('/')) return path.posix.normalize(h.slice(1))
  return path.posix.normalize(path.posix.join(path.posix.dirname(seitenPfad), h))
}
function hrefPasst (kopf, datei, seitenPfad = 'index.html') {
  if (/\b(hreflang|lang)\s*=/i.test(kopf)) return false
  if (/\bhref\s*=\s*["'][^"']*#/i.test(kopf)) return false   // Sprungmarken (kontakt.html#anfahrt) sind eigene Eintraege
  return hrefZiel(kopf, seitenPfad) === datei
}
// Attributwert aus einem oeffnenden Tag - egal ob "…", '…' oder ohne Zeichen.
function attributWert (kopf, name) {
  const m = kopf.match(new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'))
  return m ? (m[1] ?? m[2] ?? m[3]).toLowerCase() : ''
}

// Bereich eines Elements aus seinen Vorfahren. html/body zaehlen nicht
// (<body class="has-nav"> waere sonst ueberall «Navigation»). Gleiche Regeln
// im Browser: ui/editor.js imInhalt() - und in Sitepilot lib/seitentypen.js.
function bereichVon (ahnen) {
  const a = ahnen.filter(x => x.tag !== 'html' && x.tag !== 'body')
  if (a.some(x => x.tag === 'footer' || /footer/.test(attributWert(x.kopf, 'class'))
    || /footer/.test(attributWert(x.kopf, 'id')) || /\sdata-site-footer\b/i.test(x.kopf))) return 'footer'
  if (a.some(x => x.tag === 'nav' || x.tag === 'header' || attributWert(x.kopf, 'role') === 'dialog'
    || /\b(mnav|menu|nav|dd-menu|dropdown|sub)\b/.test(attributWert(x.kopf, 'class')))) return 'navigation'
  return 'inhalt'
}

// Text-Elemente: Links darin stehen im Fliesstext, nicht in einer Liste.
const TEXT_ELTERN = new Set(['p', 'span', 'em', 'strong', 'b', 'i', 'small', 'label', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'dd', 'dt', 'figcaption', 'q', 'cite'])

// Zwischen Listeneintraegen steht hoechstens ein Trennzeichen (| · / ,) -
// sonst ist es ein Satz mit Links.
function nurTrenner (quelltext, geschwister) {
  for (let i = 1; i < geschwister.length; i++) {
    const zwischen = quelltext.slice(geschwister[i - 1].ende, geschwister[i].start)
      .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/&[a-z0-9#]+;/gi, '·')
    if (!/^[\s|·•\/,–—-]*$/.test(zwischen)) return false
  }
  return true
}

// Zeigt ein Eintrag auf die Startseite (/, ./, index.html, en/index.html)?
// Dann ist die Liste das Hauptmenue - das gehoert der Agentur.
function zeigtAufStart (html, seitenPfad) {
  for (const a of html.matchAll(/<a\b[^>]*>/gi)) {
    const h = (a[0].match(/\bhref\s*=\s*["']([^"'#?]*)/i) || [])[1]
    if (h == null || /^[a-z]+:/i.test(h)) continue
    if (h === '' || h.endsWith('/')) return true
    const ziel = hrefZiel(a[0], seitenPfad)
    if (ziel && /^([a-z]{2}(-[a-z]{2})?\/)?index\.html?$/i.test(ziel)) return true
  }
  return false
}

function listenFinden (quelltext, datei, seitenPfad = 'index.html') {
  const proListe = new Map()
  for (const v of vorkommenFinden(quelltext, datei, seitenPfad)) {
    if (!proListe.has(v.eltern.start)) proListe.set(v.eltern.start, v)
  }
  return [...proListe.values()]
}

function vorkommenFinden (quelltext, datei, seitenPfad = 'index.html') {
  const blind = blindKopie(quelltext)
  const funde = []
  const gesehen = new Set()
  for (const m of blind.matchAll(/<a\b[^>]*>/gi)) {
    if (!hrefPasst(m[0], datei, seitenPfad)) continue
    const ahnen = vorfahren(blind, m.index)
    const kette = [{ start: m.index }, ...[...ahnen].reverse()]   // innerstes zuerst
    for (let stufe = 0; stufe < Math.min(4, kette.length - 1); stufe++) {
      const el = elementAb(quelltext, kette[stufe].start)
      const eltern = elementAb(quelltext, kette[stufe + 1].start)
      if (!el || !eltern || ['body', 'html', 'main'].includes(eltern.tag)) break
      const innenStart = eltern.start + eltern.html.indexOf('>') + 1
      const innenEnde = eltern.ende - (`</${eltern.tag}>`.length)
      // Links im Fliesstext («Siehe <a>A</a> und <a>B</a>») sind keine Liste.
      if (TEXT_ELTERN.has(eltern.tag)) break
      // nachbarn = alle gleichartigen Kinder (fuer Abstaende), geschwister =
      // nur die, die auf SEITEN zeigen - ein Knopfpaar «Termin buchen» +
      // «Anrufen» (tel:) ist keine Liste.
      const nachbarn = kinderFinden(quelltext, innenStart, innenEnde).filter(k => k.tag === el.tag)
      const geschwister = nachbarn
        .filter(k => /<a\b[^>]*\bhref\s*=\s*["'](?!tel:|mailto:|#|https?:|javascript:)[^"']+["']/i.test(k.html))
      if (geschwister.length >= 2 && nurTrenner(quelltext, nachbarn)) {
        if (gesehen.has(el.start)) break
        gesehen.add(el.start)
        const bereich = bereichVon(ahnen.filter(a => a.start <= eltern.start))
        // Hauptmenue = Liste, die auch die Startseite enthaelt - dort legt
        // nur die Agentur Punkte an (Entscheid 11.10.2026).
        const hauptmenue = bereich === 'navigation' && geschwister.some(g => zeigtAufStart(g.html, seitenPfad))
        funde.push({ ...el, eltern: { start: eltern.start, innenStart, innenEnde }, geschwister, nachbarn, bereich, hauptmenue })
        break
      }
    }
  }
  return funde
}

// Prueft eine Musterseite: wo wuerden neue Seiten dieses Typs eingetragen?
export async function musterPruefen (id, muster, seiten) {
  const proBereich = { navigation: 0, footer: 0, inhalt: 0 }
  const beispiele = []
  let hauptmenue = 0
  let seitenMit = 0
  for (const rel of seiten) {
    let qt
    try { qt = await fs.readFile(path.join(quellPfad(id), rel), 'utf8') } catch { continue }
    const listen = listenFinden(qt, muster, rel)
    if (!listen.length) continue
    seitenMit++
    for (const l of listen) {
      if (l.hauptmenue) { hauptmenue++; continue }
      proBereich[l.bereich]++
      if (beispiele.length < 6 && !beispiele.some(b => b.bereich === l.bereich && b.text === sichtbarerText(l.html))) {
        beispiele.push({ seite: rel, bereich: l.bereich, text: sichtbarerText(l.html).slice(0, 120), eintraege: l.geschwister.length })
      }
    }
  }
  return { proBereich, beispiele, hauptmenue, seitenMit }
}
