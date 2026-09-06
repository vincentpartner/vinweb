// Baustein-Bibliothek (VinWeb-Midi, Etappe 2).
//
// VinWebMidi baut neue Unterseiten aus DESIGN-BAUSTEINEN der bestehenden
// Website - die KI schreibt nie eigenes HTML, sie kombiniert nur Bausteine.
// Dieses Modul ERNTET die Kandidaten dafuer: Es liest eine fertige Seite und
// schlaegt ihre grossen Sektionen (Hero, Galerie, CTA ...) als Bausteine vor.
// Die Agentur prueft, benennt und gibt frei; das Ergebnis liegt als
// bibliothek.json im Projektordner (neben projekt.json, wie Minis mini.json).
//
// Wie bei Minis bloecke.js wird der ROHTEXT mit Tag-Balancierung gelesen -
// bewusst kein HTML-Parser, der beim Zurueckschreiben die ganze Datei
// umformatieren wuerde. Geerntet wird hier nur lesend; herausgeschnitten
// wird erst beim Seitenbau (Etappe 4), dann byte-genau ueber denselben Pfad.

import fs from 'node:fs/promises'
import path from 'node:path'
import { projektPfad } from './projects.js'

// Das feste Vokabular der Etiketten - die KI waehlt spaeter danach aus.
export const ETIKETTEN = [
  { wert: 'hero', name: 'Hero / Seitenkopf' },
  { wert: 'text', name: 'Textblock' },
  { wert: 'galerie', name: 'Bildergalerie' },
  { wert: 'video', name: 'Video' },
  { wert: 'kacheln', name: 'Kachelraster' },
  { wert: 'cta', name: 'Aufruf (CTA)' },
  { wert: 'zitat', name: 'Zitat' },
  { wert: 'kontakt', name: 'Kontakt' },
  { wert: 'stoerer', name: 'Störer' },
  { wert: 'abschluss', name: 'Abschluss / Fuss' },
]

// ---------------------------------------------------------------------------
// Rohtext-Werkzeuge (Tag-Balancierung wie in Minis bloecke.js)
// ---------------------------------------------------------------------------

// Elemente ohne schliessenden Tag - fuer die Kind-Suche.
const OHNE_ENDE = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source',
  'track', 'wbr', 'area', 'base', 'col', 'embed'])

// Schneidet das Element aus, dessen "<" an Position <start> steht (balanciert).
export function elementAb (quelltext, start) {
  const tagTreffer = quelltext.slice(start).match(/^<([a-zA-Z][a-zA-Z0-9-]*)/)
  if (!tagTreffer) return null
  const tag = tagTreffer[1].toLowerCase()

  if (OHNE_ENDE.has(tag)) {
    const zu = quelltext.indexOf('>', start)
    if (zu < 0) return null
    return { tag, start, ende: zu + 1, html: quelltext.slice(start, zu + 1) }
  }

  const zaehler = new RegExp('<' + tag + '\\b|</' + tag + '\\s*>', 'gi')
  zaehler.lastIndex = start
  let tiefe = 0
  let z
  while ((z = zaehler.exec(quelltext)) !== null) {
    if (z[0][1] === '/') {
      tiefe--
      if (tiefe === 0) {
        const ende = z.index + z[0].length
        return { tag, start, ende, html: quelltext.slice(start, ende) }
      }
    } else {
      tiefe++
    }
  }
  return null   // Element nie geschlossen - lieber gar nicht anbieten
}

// Findet die DIREKTEN Kind-Elemente im Bereich [von, bis) des Quelltexts.
// Kommentare werden uebersprungen, script/style am Stueck.
export function kinderFinden (quelltext, von, bis) {
  const kinder = []
  let pos = von
  while (pos < bis) {
    const spitz = quelltext.indexOf('<', pos)
    if (spitz < 0 || spitz >= bis) break
    if (quelltext.startsWith('<!--', spitz)) {
      const zu = quelltext.indexOf('-->', spitz)
      pos = zu < 0 ? bis : zu + 3
      continue
    }
    // Schliessende Tags und <!doctype> gehoeren nicht zu den Kindern.
    if (quelltext[spitz + 1] === '/' || quelltext[spitz + 1] === '!') {
      pos = spitz + 1
      continue
    }
    const element = elementAb(quelltext, spitz)
    if (!element || element.ende > bis) { pos = spitz + 1; continue }
    kinder.push(element)
    pos = element.ende
  }
  return kinder
}

// Der sichtbare Text eines HTML-Ausschnitts: Skripte/Styles raus, Tags raus,
// die haeufigsten Entities decodiert, Weissraum zusammengefasst.
export function sichtbarerText (html) {
  return html
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

// Liest ein Attribut aus dem OEFFNENDEN Tag eines Elements.
function attributLesen (elementHtml, name) {
  const kopf = elementHtml.slice(0, elementHtml.indexOf('>') + 1)
  const treffer = kopf.match(new RegExp(name + '\\s*=\\s*["\']([^"\']*)["\']', 'i'))
  return treffer ? treffer[1] : ''
}

// ---------------------------------------------------------------------------
// Sektionen ernten
// ---------------------------------------------------------------------------

// Was in der Seitenstruktur NIE ein Baustein ist.
const UEBERGANGEN = new Set(['script', 'style', 'link', 'template', 'header', 'nav', 'footer'])

// Liest eine ganze Seite und liefert die Baustein-Kandidaten mit Pfad,
// CSS-Selektor, Etikett-Vorschlag, Namensvorschlag und Fuellstellen.
export function sektionenErnten (quelltext) {
  const koerperAuf = quelltext.match(/<body[^>]*>/i)
  if (!koerperAuf) return []
  const von = koerperAuf.index + koerperAuf[0].length
  const bis = quelltext.lastIndexOf('</body>')
  if (bis < 0) return []

  const kandidaten = []

  // pfad = Kette von {tag, n}; n zaehlt unter GLEICHNAMIGEN Geschwistern
  // (entspricht :nth-of-type, im Rohtext und im Browser gleich zaehlbar).
  function sammeln (kinder, elternPfad, tiefe) {
    const zaehlerJeTag = {}
    for (const kind of kinder) {
      const n = zaehlerJeTag[kind.tag] = (zaehlerJeTag[kind.tag] || 0) + 1
      if (UEBERGANGEN.has(kind.tag)) continue
      const pfad = [...elternPfad, { tag: kind.tag, n }]

      // In <main> und in Struktur-Wrapper (div mit mehreren Sektionen darin)
      // steigen wir ab - die eigentlichen Bausteine liegen eine Ebene tiefer.
      const innen = kind.html.slice(kind.html.indexOf('>') + 1,
        kind.html.length - (`</${kind.tag}>`.length))
      const unterKinder = kinderFinden(innen, 0, innen.length)
      const strukturKinder = unterKinder.filter(u =>
        u.tag === 'section' || u.tag === 'article').length
      const istWrapper = kind.tag === 'main'
        || (kind.tag === 'div' && strukturKinder >= 2 && tiefe < 2)
      if (istWrapper) {
        sammeln(unterKinder, pfad, tiefe + 1)
        continue
      }

      if (!['section', 'article', 'div', 'aside'].includes(kind.tag)) continue
      const text = sichtbarerText(kind.html)
      const ohneSvg = kind.html.replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, ' ')
      const bilder = (ohneSvg.match(/<img\b/gi) || []).length
        + (ohneSvg.match(/<image-slot\b/gi) || []).length
      // <section>/<article> sind per Bauart Gliederungs-Bausteine der Seite -
      // sie zaehlen immer (auch z. B. ein Kalkulator, dessen Inhalt ein Skript
      // erzeugt). Nur nackte div/aside brauchen genug eigenen Inhalt, sonst
      // schluegen wir jeden Deko-Wrapper vor.
      const istGliederung = kind.tag === 'section' || kind.tag === 'article'
      if (istGliederung && text.length < 10 && bilder === 0
        && !/<(script|form|canvas|iframe|video)\b/i.test(kind.html)) continue
      if (!istGliederung && text.length < 120 && bilder === 0) continue

      kandidaten.push(kandidatBauen(kind, pfad, text, kandidaten.length === 0))
    }
  }

  sammeln(kinderFinden(quelltext, von, bis), [], 0)
  return kandidaten
}

// Baut aus einem gefundenen Element den Kandidaten fuers Pruefen in VinWeb.
function kandidatBauen (element, pfad, text, istErster) {
  const html = element.html
  const ohneSvg = html.replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, ' ')
  const klasse = attributLesen(html, 'class').toLowerCase()

  const bilder = (ohneSvg.match(/<img\b/gi) || []).length
    + (ohneSvg.match(/<image-slot\b/gi) || []).length
  const videos = (html.match(/<video\b/gi) || []).length
    + (html.match(/<iframe\b[^>]*(youtube|vimeo)/gi) || []).length
  const ueberschriftTreffer = html.match(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1\s*>/i)
  const ueberschrift = ueberschriftTreffer ? sichtbarerText(ueberschriftTreffer[2]) : ''
  const fuellstellen = fuellstellenFinden(html)
  const knoepfe = fuellstellen.filter(f => f.art === 'knopf').length

  // Etikett-Vorschlag - eine bewusst einfache Reihenfolge von Faustregeln.
  let etikett = 'text'
  if (videos > 0) etikett = 'video'
  else if (/stoerer|störer|ribbon|badge/.test(klasse)) etikett = 'stoerer'
  else if (/quote|zitat/.test(klasse) || /<blockquote\b/i.test(html)) etikett = 'zitat'
  else if (/<form\b/i.test(html) || /mailto:|tel:/i.test(html)) etikett = 'kontakt'
  else if (bilder >= 3 && text.length < 400) etikett = 'galerie'
  else if (/kachel|cards|grid|tiles/.test(klasse)
    || (html.match(/<a\b[^>]*>[\s\S]*?<h[3-5]/gi) || []).length >= 3) etikett = 'kacheln'
  else if (istErster || /hero|first|kopf/.test(klasse)) etikett = 'hero'
  else if (knoepfe >= 1 && text.length < 260) etikett = 'cta'

  const etikettName = ETIKETTEN.find(e => e.wert === etikett)?.name || etikett
  // Ohne Ueberschrift und Text (z. B. ein Kalkulator, dessen Inhalt ein
  // Skript erzeugt) hilft die Selbstauskunft des Elements weiter.
  const kern = ueberschrift || text.slice(0, 40)
    || attributLesen(html, 'data-screen-label')
    || attributLesen(html, 'aria-label')
    || attributLesen(html, 'id')
  const name = (kern ? `${etikettName} – «${kern.slice(0, 42)}»` : etikettName).trim()

  return {
    pfad,
    selektor: selektorAusPfad(pfad),
    name,
    etiketten: [etikett],
    ueberschrift,
    zeichen: text.length,
    bilder,
    videos,
    fuellstellen,
  }
}

// Aus dem Pfad wird der CSS-Selektor, mit dem Browser (Miniatur) und
// Seitenbau (Etappe 4) dasselbe Element finden.
export function selektorAusPfad (pfad) {
  return 'body > ' + pfad.map(s => `${s.tag}:nth-of-type(${s.n})`).join(' > ')
}

// Findet die FUELLSTELLEN eines Bausteins: Texte, Bilder, Videos, Knoepfe.
// Die KI (Etappe 4) darf spaeter genau diese Stellen mit Inhalt fuellen.
function fuellstellenFinden (html) {
  const funde = []
  const ohneSvg = html.replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, ' ')
  let lauf = 0
  const dazu = (art, beschreibung, beispiel, zeichen) => {
    if (funde.length >= 30) return
    funde.push({
      id: 'f' + (++lauf),
      art,
      beschreibung,
      beispiel: (beispiel || '').slice(0, 90),
      zeichen: zeichen || 0,
      aktiv: true,   // die Agentur kann einzelne Stellen abwaehlen
    })
  }

  for (const t of ohneSvg.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
    const text = sichtbarerText(t[2])
    if (text) dazu('text', `Überschrift (${text.length} Zeichen)`, text, text.length)
  }
  for (const t of ohneSvg.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
    const text = sichtbarerText(t[1])
    if (text.length >= 3) dazu('text', `Absatz (${text.length} Zeichen)`, text, text.length)
  }
  for (const t of ohneSvg.matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const text = sichtbarerText(t[2])
    if (text && text.length <= 40) dazu('knopf', 'Knopf / Verweis', text, text.length)
  }
  // Rueckfall: Manche Sektionen tragen ihren Text nicht in h/p, sondern in
  // nackten span/div-Blaettern (z. B. Laufband-Texte). Nur wenn oben nichts
  // gefunden wurde: die Blatt-Texte einsammeln - ohne Doppelte, maximal 10.
  if (!funde.some(f => f.art === 'text')) {
    const gesehen = new Set()
    for (const t of ohneSvg.matchAll(/<(span|div|em|strong|figcaption)\b[^>]*>([^<]{8,300})<\/\1\s*>/gi)) {
      const text = sichtbarerText(t[2])
      if (text.length < 8 || gesehen.has(text) || gesehen.size >= 10) continue
      gesehen.add(text)
      dazu('text', `Text (${text.length} Zeichen)`, text, text.length)
    }
  }

  const bilder = (ohneSvg.match(/<img\b/gi) || []).length
    + (ohneSvg.match(/<image-slot\b/gi) || []).length
  for (let i = 0; i < bilder; i++) dazu('bild', 'Bild ' + (i + 1), '', 0)
  const videos = (html.match(/<video\b/gi) || []).length
    + (html.match(/<iframe\b[^>]*(youtube|vimeo)[^>]*>/gi) || []).length
  for (let i = 0; i < videos; i++) dazu('video', 'Video ' + (i + 1), '', 0)

  return funde
}

// ---------------------------------------------------------------------------
// Bibliothek lesen und schreiben
// ---------------------------------------------------------------------------

function bibliothekDatei (id) {
  return path.join(projektPfad(id), 'bibliothek.json')
}

export async function bibliothekLesen (id) {
  try {
    const roh = JSON.parse(await fs.readFile(bibliothekDatei(id), 'utf8'))
    if (Array.isArray(roh?.bausteine)) return roh
  } catch { /* noch keine Bibliothek - leer beginnen */ }
  return { bausteine: [] }
}

export async function bibliothekSchreiben (id, bibliothek) {
  await fs.writeFile(bibliothekDatei(id),
    JSON.stringify(bibliothek, null, 2) + '\n', 'utf8')
}
