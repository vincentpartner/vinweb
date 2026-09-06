// Inhalte ernten: Texte und Bilder einer bestehenden Website einsammeln.
//
// Bewusst NICHT das Ziel: die Website lauffähig spiegeln. Geerntet wird nur
// der Rohstoff für den Neubau – Texte als Markdown, Bilder in Originalqualität.
//
// Anstand gegenüber dem fremden Server:
//   - eine Anfrage nach der anderen, mit kurzer Pause dazwischen
//   - robots.txt wird gelesen und beachtet
//   - Obergrenzen für Seitenzahl und Bildgrösse
//   - nur die angegebene Domain, nie Nachbarn

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import * as cheerio from 'cheerio'
import sharp from 'sharp'
import { ROOT } from './config.js'

export const ERNTE_DIR = path.join(ROOT, 'ernte')

const PAUSE_MS = 300           // Pause zwischen zwei Anfragen
const TIMEOUT_MS = 15000
const MAX_BILD_BYTES = 25 * 1024 * 1024
const MIN_BILD_PIXEL = 80      // darunter: gar nicht erst speichern (Zählpixel, Mini-Icons)

// Ab wann gilt ein Bild als "Inhalt" (Foto, Screenshot, Grafik) und nicht als
// Beiwerk (Icon, kleines Logo)? Wer die Grenzen ändern will: hier.
const INHALT_MIN_BREITE = 300
const INHALT_MIN_HOEHE = 200
const INHALT_MIN_BYTES = 60 * 1024   // grosse Datei zählt auch bei schmalem Format

const pause = (ms) => new Promise(r => setTimeout(r, ms))

function slug (text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'seite'
}

async function holen (url, alsText = true) {
  const antwort = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'VinWeb-Ernte/1.0 (Inhaltsübernahme im Kundenauftrag)' },
  })
  if (!antwort.ok) throw new Error('HTTP ' + antwort.status)
  return {
    daten: alsText ? await antwort.text() : Buffer.from(await antwort.arrayBuffer()),
    typ: antwort.headers.get('content-type') || '',
    endUrl: antwort.url,
  }
}

// ---------------------------------------------------------------------------
// robots.txt: einfache Disallow-Regeln für alle Bots beachten
// ---------------------------------------------------------------------------

async function robotsLesen (basis) {
  const verboten = []
  try {
    const { daten } = await holen(new URL('/robots.txt', basis).href)
    let giltFuerAlle = false
    for (const zeile of daten.split('\n')) {
      const z = zeile.trim()
      if (/^user-agent:/i.test(z)) giltFuerAlle = /:\s*\*\s*$/.test(z)
      else if (giltFuerAlle && /^disallow:/i.test(z)) {
        const pfad = z.split(':')[1]?.trim()
        if (pfad) verboten.push(pfad)
      }
    }
  } catch { /* keine robots.txt – alles erlaubt */ }
  return verboten
}

function erlaubt (url, verboten) {
  const pfad = new URL(url).pathname
  return !verboten.some(v => pfad.startsWith(v))
}

// ---------------------------------------------------------------------------
// Seitenliste: erst die sitemap.xml versuchen, sonst Links verfolgen
// ---------------------------------------------------------------------------

async function seitenAusSitemap (basis, host, maxSeiten) {
  const kandidaten = ['/sitemap.xml', '/sitemap_index.xml']
  for (const k of kandidaten) {
    try {
      const { daten } = await holen(new URL(k, basis).href)
      let urls = [...daten.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1].trim())
      // Ein Sitemap-Index verweist auf weitere Sitemaps – eine Ebene folgen.
      const unterSitemaps = urls.filter(u => /\.xml(\?|$)/i.test(u)).slice(0, 5)
      if (unterSitemaps.length && unterSitemaps.length === urls.length) {
        urls = []
        for (const su of unterSitemaps) {
          await pause(PAUSE_MS)
          try {
            const { daten: d2 } = await holen(su)
            urls.push(...[...d2.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1].trim()))
          } catch { /* diese Untersitemap auslassen */ }
        }
      }
      const gleicheDomain = urls.filter(u => {
        try { return new URL(u).host === host && !/\.(xml|pdf|zip|jpg|jpeg|png|webp|gif|svg|mp4)(\?|$)/i.test(u) } catch { return false }
      })
      if (gleicheDomain.length) return [...new Set(gleicheDomain)].slice(0, maxSeiten)
    } catch { /* nächsten Kandidaten versuchen */ }
  }
  return null
}

// ---------------------------------------------------------------------------
// Eine Seite auswerten
// ---------------------------------------------------------------------------

function seiteAuswerten (html, seitenUrl) {
  const $ = cheerio.load(html)

  const titel = $('title').first().text().trim()
  const beschreibung = $('meta[name="description"]').attr('content')?.trim() || ''
  const ogBild = $('meta[property="og:image"]').attr('content')?.trim() || ''

  // Text in Lesereihenfolge einsammeln: Überschriften, Absätze, Listen.
  const zeilen = []
  $('h1, h2, h3, h4, p, li, blockquote, figcaption, td, th').each((i, el) => {
    const tag = el.tagName.toLowerCase()
    const text = $(el).children().length > 6 ? '' : $(el).text().replace(/\s+/g, ' ').trim()
    if (!text || text.length < 2) return
    if (tag === 'h1') zeilen.push('# ' + text)
    else if (tag === 'h2') zeilen.push('## ' + text)
    else if (tag === 'h3' || tag === 'h4') zeilen.push('### ' + text)
    else if (tag === 'li') zeilen.push('- ' + text)
    else if (tag === 'blockquote') zeilen.push('> ' + text)
    else zeilen.push(text)
  })
  // Doppelte direkt aufeinanderfolgende Zeilen (verschachtelte Elemente) glätten.
  const text = zeilen.filter((z, i) => z !== zeilen[i - 1])

  // Bilder einsammeln – und zwar BEVOR Skripte und Stile entfernt werden.
  //
  // Warum so breit? Baukästen wie Tilda laden Bilder verzögert: Die Adresse
  // steht dann nicht in src, sondern in data-original, in
  // style="background-image:url(…)" oder im JSON eines Skripts. Wer nur
  // src/srcset liest, findet auf solchen Seiten fast nichts (gemessen:
  // 0 von 44 auf einer Tilda-Referenzseite).
  const bilder = new Map()   // absolute URL -> alt-Text
  const merken = (roh, alt) => {
    if (!roh || /^data:/i.test(roh)) return
    try {
      const abs = new URL(roh.trim(), seitenUrl).href
      if (!/^https?:/i.test(abs)) return
      if (!bilder.has(abs) || alt) bilder.set(abs, alt || bilder.get(abs) || '')
    } catch { /* unbrauchbare Adresse */ }
  }
  const BILD_ENDUNG = /\.(jpe?g|png|webp|gif|svg|avif)(\?[^"']*)?$/i

  // 1) img-Elemente gezielt – hier gibt es die Alt-Texte.
  $('img').each((i, el) => {
    const alt = ($(el).attr('alt') || '').trim()
    for (const a of ['src', 'data-src', 'data-original', 'data-lazy', 'data-bg']) {
      merken($(el).attr(a), alt)
    }
    const srcset = $(el).attr('srcset') || $(el).attr('data-srcset')
    if (srcset) {
      // grösste Variante = Eintrag mit der höchsten Breitenangabe
      const beste = srcset.split(',').map(t => t.trim().split(/\s+/))
        .sort((a, b) => (parseInt(b[1]) || 0) - (parseInt(a[1]) || 0))[0]
      if (beste) merken(beste[0], alt)
    }
  })

  // 2) JEDES Attribut JEDES Elements, dessen Wert wie eine Bilddatei aussieht –
  //    fängt data-original auf Nicht-img-Elementen, poster, content usw.
  $('*').each((i, el) => {
    for (const wert of Object.values(el.attribs || {})) {
      if (wert && BILD_ENDUNG.test(wert.trim())) merken(wert, '')
    }
  })

  // 3) Der rohe Seitentext: absolute Bild-Adressen überall – auch in
  //    style="background-image:…" und im Skript-JSON (dort oft mit \/ maskiert).
  const roh = html.replace(/\\\//g, '/')
  for (const m of roh.matchAll(/https?:\/\/[^\s"'<>\\)]+?\.(?:jpe?g|png|webp|gif|svg|avif)(?:\?[^\s"'<>\\)]*)?/gi)) {
    merken(m[0], '')
  }

  if (ogBild) merken(ogBild, 'Vorschaubild (og:image)')

  // Jetzt erst wegräumen, was kein Inhalt ist – für die Textauswertung.
  $('script, style, noscript, svg, iframe, template').remove()

  // Weiterführende Links auf derselben Domain (für den Fall ohne Sitemap).
  const links = []
  $('a[href]').each((i, el) => {
    try {
      const abs = new URL($(el).attr('href'), seitenUrl)
      abs.hash = ''
      links.push(abs.href)
    } catch { /* kein brauchbarer Link */ }
  })

  return { titel, beschreibung, text, bilder, links }
}

// ---------------------------------------------------------------------------
// Auflösungs-Varianten ausdünnen
// ---------------------------------------------------------------------------
// CDNs liefern dasselbe Bild oft in vielen Grössen (Tilda: 21 Varianten eines
// einzigen PNGs). Erkennbare Varianten werden VOR dem Download gruppiert und
// nur die grösste behalten. Nur bei eindeutigen Mustern – im Zweifel bleibt
// ein Bild lieber doppelt, als dass ein echtes verloren geht.

function variantenAusduennen (alleBilder) {
  const idFuer = (url) => {
    const u = new URL(url)
    // Tilda: die Bildkennung (tild…) steckt in jeder Variante derselben Datei.
    const tild = u.pathname.match(/tild[0-9a-f-]{10,}/i)
    if (tild && /tildacdn/i.test(u.host)) return u.host + ':' + tild[0]
    // WordPress-Muster: bild-300x200.jpg ist eine Variante von bild.jpg.
    const wp = u.pathname.replace(/-\d{2,4}x\d{2,4}(\.[a-z0-9]+)$/i, '$1')
    if (wp !== u.pathname) return u.host + ':' + wp
    return null   // kein bekanntes Muster – eigene Gruppe, wird nie entfernt
  }
  // Höher = besser: Original ohne Grössenangabe schlägt jede Variante.
  const rang = (url) => {
    if (!/resizeb?\//i.test(url) && !/-\d{2,4}x\d{2,4}\./.test(url)) return Infinity
    const m = url.match(/resizeb?\/(\d+)x/i) || url.match(/-(\d{2,4})x\d{2,4}\./)
    return m ? Number(m[1]) : 0
  }

  const gruppen = new Map()
  for (const url of alleBilder.keys()) {
    const id = idFuer(url)
    if (!id) continue
    if (!gruppen.has(id)) gruppen.set(id, [])
    gruppen.get(id).push(url)
  }
  let entfernt = 0
  for (const urls of gruppen.values()) {
    if (urls.length < 2) continue
    urls.sort((a, b) => rang(b) - rang(a))
    for (const u of urls.slice(1)) {
      alleBilder.delete(u)
      entfernt++
    }
  }
  return entfernt
}

// ---------------------------------------------------------------------------
// Hauptfunktion
// ---------------------------------------------------------------------------

export async function ernten ({ url, maxSeiten = 60, onMeldung = () => {} }) {
  let start
  try {
    start = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url)
  } catch {
    throw new Error('Das ist keine gültige Adresse.')
  }
  const host = start.host

  const stempel = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
  const ziel = path.join(ERNTE_DIR, `${slug(host)}-${stempel}`)
  await fs.mkdir(path.join(ziel, 'seiten'), { recursive: true })
  await fs.mkdir(path.join(ziel, 'bilder'), { recursive: true })
  await fs.mkdir(path.join(ziel, 'bilder-klein'), { recursive: true })

  onMeldung('Lese robots.txt …')
  const verboten = await robotsLesen(start.href)

  onMeldung('Suche sitemap.xml …')
  let warteschlange = await seitenAusSitemap(start.href, host, maxSeiten)
  const perSitemap = !!warteschlange
  if (!warteschlange) {
    onMeldung('Keine Sitemap gefunden – folge den Links der Startseite.')
    warteschlange = [start.href]
  }

  const besucht = new Set()
  const seiten = []
  const alleBilder = new Map()   // URL -> { alt, seiten: [] }
  const fehler = []

  while (warteschlange.length && seiten.length < maxSeiten) {
    const aktuelleUrl = warteschlange.shift()
    const schluessel = aktuelleUrl.replace(/\/$/, '')
    if (besucht.has(schluessel)) continue
    besucht.add(schluessel)
    if (!erlaubt(aktuelleUrl, verboten)) { fehler.push({ url: aktuelleUrl, grund: 'durch robots.txt untersagt' }); continue }

    await pause(PAUSE_MS)
    onMeldung(`Seite ${seiten.length + 1}: ${new URL(aktuelleUrl).pathname || '/'}`)

    let antwort
    try {
      antwort = await holen(aktuelleUrl)
    } catch (e) {
      fehler.push({ url: aktuelleUrl, grund: e.message })
      continue
    }
    if (!/text\/html/i.test(antwort.typ)) continue

    const s = seiteAuswerten(antwort.daten, antwort.endUrl)
    seiten.push({ url: aktuelleUrl, ...s })

    for (const [b, alt] of s.bilder) {
      if (!alleBilder.has(b)) alleBilder.set(b, { alt, seiten: [] })
      alleBilder.get(b).seiten.push(aktuelleUrl)
    }
    // Ohne Sitemap: gefundene Links derselben Domain anhängen.
    if (!perSitemap) {
      for (const l of s.links) {
        try {
          const u = new URL(l)
          if (u.host === host && !besucht.has(u.href.replace(/\/$/, ''))
            && !/\.(pdf|zip|jpg|jpeg|png|webp|gif|svg|mp4|webm|doc|docx|xls|xlsx)(\?|$)/i.test(u.pathname)) {
            warteschlange.push(u.href)
          }
        } catch { /* auslassen */ }
      }
    }
  }

  // --- Auflösungs-Varianten ausdünnen, dann herunterladen ---
  const varianten = variantenAusduennen(alleBilder)
  onMeldung(`Lade ${alleBilder.size} Bilder (${varianten} Auflösungs-Varianten ausgelassen) …`)
  const geladen = []
  const inhaltHashes = new Set()   // doppelte Dateien (gleicher Inhalt) nur einmal
  const namen = new Set()

  for (const [bildUrl, info] of alleBilder) {
    await pause(PAUSE_MS / 2)
    try {
      const { daten } = await holen(bildUrl, false)
      if (daten.length > MAX_BILD_BYTES) { fehler.push({ url: bildUrl, grund: 'über ' + (MAX_BILD_BYTES / 1048576) + ' MB' }); continue }

      const hash = crypto.createHash('sha1').update(daten).digest('hex')
      if (inhaltHashes.has(hash)) continue

      const istSvg = /\.svg(\?|$)/i.test(bildUrl) || daten.slice(0, 300).toString().includes('<svg')
      let breite = 0, hoehe = 0
      if (!istSvg) {
        try {
          const m = await sharp(daten).metadata()
          breite = m.width || 0
          hoehe = m.height || 0
          if (breite < MIN_BILD_PIXEL && hoehe < MIN_BILD_PIXEL) continue // Zählpixel, Mini-Icon
        } catch { continue } // kein lesbares Bild (Tracking-Pixel u. ä.)
      }
      inhaltHashes.add(hash)

      let basis = slug(path.basename(new URL(bildUrl).pathname).replace(/\.[a-z0-9]+$/i, '')).slice(0, 60) || 'bild'
      const endung = (bildUrl.match(/\.(jpe?g|png|webp|gif|svg|avif)(\?|$)/i)?.[1] || 'img').toLowerCase()
      let name = `${basis}.${endung}`
      if (namen.has(name)) name = `${basis}-${hash.slice(0, 6)}.${endung}`
      namen.add(name)

      // Einordnung: echtes Inhaltsbild oder Beiwerk (Icon, kleines Logo)?
      // SVGs landen immer bei "klein" – dort stehen meist Logos und Icons,
      // und Logos will man zwar behalten, aber getrennt von den Fotos.
      const istInhalt = !istSvg
        && ((breite >= INHALT_MIN_BREITE && hoehe >= INHALT_MIN_HOEHE) || daten.length >= INHALT_MIN_BYTES)
      const ordner = istInhalt ? 'bilder' : 'bilder-klein'

      await fs.writeFile(path.join(ziel, ordner, name), daten)
      geladen.push({ name, ordner, url: bildUrl, alt: info.alt, bytes: daten.length, breite, hoehe, istSvg })
    } catch (e) {
      fehler.push({ url: bildUrl, grund: e.message })
    }
  }

  // --- Wiederkehrende Zeilen (Navigation, Fusszeile) aussortieren ---
  const zaehler = new Map()
  for (const s of seiten) for (const z of new Set(s.text)) zaehler.set(z, (zaehler.get(z) || 0) + 1)
  const wiederkehrend = seiten.length >= 4
    ? new Set([...zaehler].filter(([, n]) => n >= seiten.length * 0.6).map(([z]) => z))
    : new Set()

  // --- Markdown schreiben ---
  const seitenTeil = []
  for (const s of seiten) {
    const pfad = new URL(s.url).pathname.replace(/\/$/, '') || '/startseite'
    const datei = slug(pfad) + '.md'
    const inhalt = [
      '# ' + (s.titel || pfad),
      '',
      'Adresse: ' + s.url,
      s.beschreibung ? 'Beschreibung: ' + s.beschreibung : '',
      '',
      '---',
      '',
      ...s.text.filter(z => !wiederkehrend.has(z)),
    ].filter(x => x !== '').join('\n')
    await fs.writeFile(path.join(ziel, 'seiten', datei), inhalt + '\n', 'utf8')
    seitenTeil.push(inhalt)
  }

  const uebersicht = [
    '# Ernte von ' + host,
    '',
    `Stand: ${new Date().toLocaleString('de-CH')} · ${seiten.length} Seiten · ${geladen.length} Bilder`,
    perSitemap ? 'Seitenliste aus der sitemap.xml.' : 'Seitenliste durch Verfolgen der Links.',
    '',
    wiederkehrend.size
      ? '## Wiederkehrende Elemente (Navigation / Fusszeile)\n\n' + [...wiederkehrend].join('\n') + '\n'
      : '',
    '## Bilder (Inhalt)\n',
    ...geladen.filter(g => g.ordner === 'bilder')
      .map(g => `- bilder/${g.name}` + (g.alt ? ` — «${g.alt}»` : '') + ` (${Math.round(g.bytes / 1024)} KB)`),
    '',
    '## Logos, Icons und Kleinkram (bilder-klein/)\n',
    ...geladen.filter(g => g.ordner === 'bilder-klein')
      .map(g => `- bilder-klein/${g.name}` + (g.alt ? ` — «${g.alt}»` : '')),
    '',
    '---',
    '',
    ...seitenTeil,
  ].filter(x => x !== '').join('\n')
  await fs.writeFile(path.join(ziel, 'inhalte.md'), uebersicht + '\n', 'utf8')

  await galerieSchreiben(ziel, host, geladen)

  const bericht = {
    host,
    ordner: ziel,
    erstelltAm: new Date().toISOString(),
    perSitemap,
    seiten: seiten.length,
    bilder: geladen.filter(g => g.ordner === 'bilder').length,
    bilderKlein: geladen.filter(g => g.ordner === 'bilder-klein').length,
    variantenAusgelassen: varianten,
    bilderBytes: geladen.reduce((s, g) => s + g.bytes, 0),
    fehler,
  }
  await fs.writeFile(path.join(ziel, 'bericht.json'), JSON.stringify(bericht, null, 2), 'utf8')
  return bericht
}

// ---------------------------------------------------------------------------
// Galerie: eine HTML-Seite mit allen Bildern zum schnellen Aussortieren
// ---------------------------------------------------------------------------
// Öffnet man per Doppelklick. Jedes Bild zeigt Name, Masse, Grösse und Alt-Text.
// Was nicht gefällt, löscht man danach im Finder – die Galerie ist die Übersicht.

async function galerieSchreiben (ziel, host, geladen) {
  const karte = (g) => `
    <figure>
      <a href="${g.ordner}/${g.name}" target="_blank"><img src="${g.ordner}/${g.name}" loading="lazy" alt=""></a>
      <figcaption>
        <b>${g.name}</b><br>
        ${g.istSvg ? 'SVG (Vektor)' : `${g.breite} × ${g.hoehe} px`} · ${Math.round(g.bytes / 1024)} KB
        ${g.alt ? `<br><i>«${g.alt}»</i>` : ''}
      </figcaption>
    </figure>`

  const inhalt = geladen.filter(g => g.ordner === 'bilder')
  const klein = geladen.filter(g => g.ordner === 'bilder-klein')

  const html = `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bilder von ${host}</title>
<style>
  body{font:14px/1.5 -apple-system,Helvetica,Arial,sans-serif;margin:0;padding:28px;background:#FAF9F5;color:#17181B}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:14px;margin:34px 0 12px;text-transform:uppercase;letter-spacing:.08em;color:#9A9C9F}
  p.hilfe{color:#5B5E66;font-size:13px;max-width:70ch}
  .raster{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
  figure{margin:0;background:#fff;border:1px solid #D8D7CD;border-radius:3px;overflow:hidden}
  figure img{width:100%;height:150px;object-fit:contain;background:
    repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 0 0 / 18px 18px;display:block}
  figcaption{padding:8px 10px;font-size:11px;color:#5B5E66;word-break:break-all}
  figcaption b{color:#17181B;font-weight:600}
</style></head><body>
<h1>Bilder von ${host}</h1>
<p class="hilfe">Übersicht zum Aussortieren: durchscrollen, und was du nicht brauchst,
im Finder aus dem jeweiligen Ordner löschen. Klick auf ein Bild zeigt es in voller Grösse.</p>
<h2>Inhalt – Fotos, Screenshots, Grafiken (${inhalt.length})</h2>
<div class="raster">${inhalt.map(karte).join('')}</div>
<h2>Logos, Icons, Kleinkram (${klein.length})</h2>
<div class="raster">${klein.map(karte).join('')}</div>
</body></html>`
  await fs.writeFile(path.join(ziel, 'galerie.html'), html, 'utf8')
}
