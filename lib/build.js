// Etappe 2 – der Produktions-Build.
//
// Aus dem Rohexport wird eine hostbare Website. Vier Aufgaben:
//   1. Nur die Dateien übernehmen, die auf den Server gehören.
//   2. Fremde Quellen (Tilda-Bilder u. a.) herunterladen und lokal einbinden.
//   3. Grosse Bilder verkleinern.
//   4. Dateinamen auf Kleinschreibung bringen, interne Links mitziehen.
//
// Alles landet in projects/<id>/build/. Die Quelle bleibt unberührt – der Build
// lässt sich jederzeit verwerfen und neu erzeugen.

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { quellPfad, projektPfad } from './projects.js'
import { sidecarsEinbacken } from './einbacken.js'

const TEXT = new Set(['.html', '.htm', '.css', '.js', '.php', '.xml', '.txt', '.json', '.md', '.webmanifest'])
const BILD = new Set(['.jpg', '.jpeg', '.png', '.webp'])

// Ab dieser Grösse lohnt sich das Verkleinern.
const BILD_GRENZE = 250 * 1024
// Grösser als das machen wir kein Bild – Fotos brauchen nicht mehr als das.
const MAX_BREITE = 2000

export function buildPfad (id) {
  return path.join(projektPfad(id), 'build')
}

// ---------------------------------------------------------------------------
// 1) Auswahl: was gehört auf den Server?
// ---------------------------------------------------------------------------

function serverEintraege (projekt) {
  const auswahl = projekt.auswahl || {}
  const erlaubt = new Set()
  const gesperrt = new Set()   // einzelne Dateien mit Zugangsdaten
  for (const e of projekt.analyse?.struktur || []) {
    const server = auswahl[e.name]?.server ?? e.server
    if (server) erlaubt.add(e.name)
    for (const g of e.zugangsdaten || []) gesperrt.add(g)
  }
  return { erlaubt, gesperrt }
}

// ---------------------------------------------------------------------------
// Dateibaum
// ---------------------------------------------------------------------------

async function alleDateien (wurzel) {
  const raus = []
  async function ab (ordner) {
    for (const e of await fs.readdir(ordner, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const voll = path.join(ordner, e.name)
      if (e.isDirectory()) await ab(voll)
      else if (e.isFile()) raus.push(path.relative(wurzel, voll).split(path.sep).join('/'))
    }
  }
  await ab(wurzel)
  return raus
}

// ---------------------------------------------------------------------------
// Fremde Quellen finden
// ---------------------------------------------------------------------------

// Nur eingebundene Adressen (Bilder, Skripte, Stile) – keine normalen Links.
function eingebundeneUrls (inhalt) {
  const treffer = new Set()
  for (const m of inhalt.matchAll(/\s(?:src|data-src|poster)\s*=\s*["']([^"']+)["']/gi)) treffer.add(m[1])
  for (const m of inhalt.matchAll(/<link\b[^>]*\shref\s*=\s*["']([^"']+)["']/gi)) treffer.add(m[1])
  for (const m of inhalt.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) treffer.add(m[1])
  return [...treffer].filter(u => /^https?:\/\//i.test(u))
}

// Google-Maps-iframe und Ähnliches: als Hinweis melden, nicht anfassen.
function istKarteOderVideo (url) {
  return /google\.com\/maps|youtube|youtu\.be|vimeo|player\./i.test(url)
}

function endungAusUrl (url) {
  const rein = url.split('?')[0].split('#')[0]
  const e = path.extname(rein).toLowerCase()
  // Die echte Endung MUSS erhalten bleiben: ein Skript mit Bild-Endung würde
  // vom Browser wegen des nosniff-Headers verweigert.
  const bekannt = ['.js', '.css', '.woff', '.woff2', '.ttf', '.mp4', '.webm',
    '.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.avif']
  return bekannt.includes(e) ? e : '.img'
}

// ---------------------------------------------------------------------------
// Herunterladen
// ---------------------------------------------------------------------------

async function ladeDatei (url, zielOrdner) {
  const antwort = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'VinWeb/1.0' },
  })
  if (!antwort.ok) throw new Error('HTTP ' + antwort.status)
  const puffer = Buffer.from(await antwort.arrayBuffer())

  // Dateiname aus einem Kurz-Hash der Adresse – stabil und ohne Sonderzeichen.
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)
  let endung = endungAusUrl(url)
  if (endung === '.img') {
    const typ = antwort.headers.get('content-type') || ''
    endung = typ.includes('javascript') ? '.js' : typ.includes('css') ? '.css'
      : typ.includes('font') ? '.woff2'
      : typ.includes('png') ? '.png' : typ.includes('webp') ? '.webp'
      : typ.includes('gif') ? '.gif' : typ.includes('svg') ? '.svg' : '.jpg'
  }
  const name = hash + endung
  await fs.mkdir(zielOrdner, { recursive: true })
  await fs.writeFile(path.join(zielOrdner, name), puffer)
  return { name, bytes: puffer.length }
}

// ---------------------------------------------------------------------------
// Bilder verkleinern
// ---------------------------------------------------------------------------

async function bildVerkleinern (voll) {
  const vorher = (await fs.stat(voll)).size
  if (vorher < BILD_GRENZE) return null

  const ext = path.extname(voll).toLowerCase()
  try {
    const bild = sharp(voll, { failOn: 'none' })
    const info = await bild.metadata()
    let kette = bild.rotate() // EXIF-Drehung fest einrechnen
    if (info.width > MAX_BREITE) kette = kette.resize({ width: MAX_BREITE })

    let ausgabe
    if (ext === '.png') ausgabe = await kette.png({ compressionLevel: 9, palette: true }).toBuffer()
    else if (ext === '.webp') ausgabe = await kette.webp({ quality: 82 }).toBuffer()
    else ausgabe = await kette.jpeg({ quality: 80, mozjpeg: true }).toBuffer()

    // Nur schreiben, wenn es wirklich kleiner wurde.
    if (ausgabe.length < vorher * 0.92) {
      await fs.writeFile(voll, ausgabe)
      return { vorher, nachher: ausgabe.length }
    }
  } catch { /* kaputtes Bild überspringen */ }
  return null
}

// ---------------------------------------------------------------------------
// Dateinamen auf Kleinschreibung
// ---------------------------------------------------------------------------

export function zuSlug (name) {
  const ext = path.extname(name)
  const stamm = name.slice(0, -ext.length || undefined)
  const sauber = stamm
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return (sauber || 'seite') + ext.toLowerCase()
}

// ---------------------------------------------------------------------------
// Der Build
// ---------------------------------------------------------------------------

export async function buildErzeugen (projekt) {
  const id = projekt.id
  const quelle = quellPfad(id)
  const ziel = buildPfad(id)

  const bericht = {
    erstelltAm: new Date().toISOString(),
    dateien: 0,
    bereinigt: [],
    uebersprungen: [],
    downloads: [],
    downloadFehler: [],
    verkleinert: [],
    umbenannt: [],
    hinweise: [],
    gespartBytes: 0,
  }

  // Frisch anfangen.
  await fs.rm(ziel, { recursive: true, force: true })
  await fs.mkdir(ziel, { recursive: true })

  const { erlaubt, gesperrt } = serverEintraege(projekt)
  const quelldateien = await alleDateien(quelle)

  // --- Schritt 1: nur erlaubte Dateien kopieren ---
  const kopiert = []
  for (const rel of quelldateien) {
    const kopf = rel.includes('/') ? rel.split('/')[0] : rel
    const grund = []
    if (!erlaubt.has(kopf)) grund.push('nicht für den Server markiert')
    if (gesperrt.has(rel)) grund.push('enthält Zugangsdaten')
    // .media-edits.state.json wird EINGEBACKEN (unten), nicht mitgeliefert.
    // Die Slot-Sidecars dagegen sind die Datenquelle ihrer Renderer und
    // gehören laut deren eigener Doku zum Ausliefern dazu.
    if (/(^|\/)\.media-edits\.state\.json$/.test(rel)) grund.push('wird in die Seiten eingebacken')
    if (/(^|\/)CLAUDE\.md$/i.test(rel)) grund.push('interne Notiz')
    if (/(^|\/)\.thumbnail$/.test(rel)) grund.push('interne Vorschau')

    if (grund.length) { bericht.uebersprungen.push({ rel, grund: grund[0] }); continue }

    const von = path.join(quelle, rel)
    const nach = path.join(ziel, rel)
    await fs.mkdir(path.dirname(nach), { recursive: true })
    await fs.copyFile(von, nach)
    kopiert.push(rel)
  }
  bericht.dateien = kopiert.length

  // --- Schritt 1b: Editor-Justierungen einbacken bzw. mitliefern ---
  // Muss VOR dem Umbenennen und Verkleinern laufen: Die eingebackenen Bilder
  // unter media/ durchlaufen danach ganz normal die Bildverkleinerung.
  bericht.einbacken = await sidecarsEinbacken(quelle, ziel)
  if (bericht.einbacken.eingebackeneBilder || bericht.einbacken.sidecars.length) {
    bericht.hinweise.push(
      `${bericht.einbacken.eingebackeneBilder} ersetzte(s) Bild(er) fest eingebacken, `
      + `${bericht.einbacken.sidecars.length} Justierungs-Datei(en) mitgeliefert `
      + `(${(bericht.einbacken.mediaBytes / 1048576).toFixed(1)} MB nach media/).`)
  }
  for (const p of bericht.einbacken.probleme) bericht.hinweise.push('Einbacken: ' + p)

  // --- Schritt 1b: Editor-Reste hinter </html> entfernen ---
  // Bearbeitungswerkzeuge hängen gern Stil-Blöcke ANS Dokumentende an
  // (z. B. <style id="__om-edit-overrides"> nach </html>). Ins Web gehört
  // nichts davon. Die Editor-SKRIPTE im Dokument bleiben unangetastet.
  for (const rel of kopiert) {
    if (!/\.html?$/i.test(rel)) continue
    const voll = path.join(ziel, rel)
    const inhalt = await fs.readFile(voll, 'utf8')
    const schluss = inhalt.toLowerCase().lastIndexOf('</html>')
    if (schluss >= 0) {
      const nachlauf = inhalt.slice(schluss + 7)
      if (nachlauf.trim()) {
        await fs.writeFile(voll, inhalt.slice(0, schluss + 7) + '\n', 'utf8')
        bericht.bereinigt.push({ rel, zeichen: nachlauf.trim().length })
      }
    }
  }

  // --- Schritt 2: fremde Quellen herunterladen ---
  const urlKarte = new Map()   // fremde URL -> lokaler Pfad (relativ zum Build)
  const externOrdner = path.join(ziel, 'assets', 'extern')
  const bekannteUrls = new Set()

  // Fremd-Adressen finden: in HTML über die Attribute, in JS und CSS über ein
  // rohes Muster – Skripte laden Bibliotheken gern erst zur Laufzeit nach
  // (z. B. Matter.js von einem CDN), und das steht mitten im Code.
  const ROH_ASSET = /https?:\/\/[^\s"'\`\\)]+?\.(?:js|css|jpe?g|png|webp|gif|svg|avif|woff2?|ttf)(\?[^\s"'\`\\)]*)?/gi
  for (const rel of kopiert) {
    const ext = path.extname(rel).toLowerCase()
    let inhalt = null
    if (/\.html?$/.test(ext)) {
      inhalt = await fs.readFile(path.join(ziel, rel), 'utf8')
      for (const url of eingebundeneUrls(inhalt)) {
        if (istKarteOderVideo(url)) continue
        bekannteUrls.add(url)
      }
    } else if (ext === '.js' || ext === '.css') {
      inhalt = await fs.readFile(path.join(ziel, rel), 'utf8')
      for (const m of inhalt.matchAll(ROH_ASSET)) {
        if (istKarteOderVideo(m[0])) continue
        // Beispiel-Adressen aus Kommentaren ("https://…/bild.jpg") aussortieren.
        try { new URL(m[0]) } catch { continue }
        bekannteUrls.add(m[0])
      }
    }
  }

  for (const url of bekannteUrls) {
    try {
      const { name, bytes } = await ladeDatei(url, externOrdner)
      urlKarte.set(url, 'assets/extern/' + name)
      bericht.downloads.push({ url, datei: 'assets/extern/' + name, bytes })
    } catch (e) {
      bericht.downloadFehler.push({ url, fehler: e.message })
    }
  }

  // --- Schritt 3: Bilder verkleinern (auch die frisch geladenen) ---
  let buildDateien = await alleDateien(ziel)
  for (const rel of buildDateien) {
    if (!BILD.has(path.extname(rel).toLowerCase())) continue
    const erg = await bildVerkleinern(path.join(ziel, rel))
    if (erg) {
      bericht.verkleinert.push({ rel, ...erg })
      bericht.gespartBytes += erg.vorher - erg.nachher
    }
  }

  // (Das Einbacken der Editor-Arbeitsdaten passiert gebündelt in Schritt 7 –
  //  lib/einbacken.js, nach dem Umbenennen der Dateien.)

  // --- Schritt 4: Dateinamen auf Kleinschreibung ---
  const nameKarte = new Map()   // alter relPfad -> neuer relPfad
  for (const rel of kopiert) {
    const teile = rel.split('/')
    const neueTeile = teile.map((t, i) => i === teile.length - 1 ? zuSlug(t) : t.toLowerCase())
    const neu = neueTeile.join('/')
    if (neu !== rel) nameKarte.set(rel, neu)
  }

  // Nur eindeutige Umbenennungen zulassen – sonst lieber gar nicht.
  const zielNamen = new Set()
  for (const neu of nameKarte.values()) {
    if (zielNamen.has(neu)) {
      bericht.hinweise.push('Umbenennung übersprungen: "' + neu + '" käme doppelt vor.')
      return schreibeBerichtUndRaus(id, ziel, bericht, urlKarte, new Map())
    }
    zielNamen.add(neu)
  }

  // --- Schritt 5: in allen Textdateien Links und Adressen ersetzen ---
  const ersetzeInText = async (relDatei) => {
    const voll = path.join(ziel, relDatei)
    let inhalt = await fs.readFile(voll, 'utf8')
    let geaendert = false

    // 5a) fremde URLs -> lokale Pfade
    const istJs = path.extname(relDatei).toLowerCase() === '.js'
    for (const [url, lokal] of urlKarte) {
      if (inhalt.includes(url)) {
        // JS: dokument-relativ (der Browser löst zur Laufzeit relativ zur Seite
        // auf, und alle Seiten liegen im Stammordner). Sonst: datei-relativ.
        const zielPfad = istJs ? lokal : relLink(relDatei, lokal)
        inhalt = inhalt.split(url).join(zielPfad)
        geaendert = true
      }
    }
    // 5b) umbenannte Dateien in Links nachziehen (nur Dateinamen, keine Ordner)
    for (const [alt, neu] of nameKarte) {
      const altName = alt.split('/').pop()
      const neuName = neu.split('/').pop()
      if (altName === neuName) continue
      // href="About.html" oder href="./About.html" – nur exakte Dateinamen treffen
      const muster = new RegExp('([="\'(/])' + altName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(["\'#?)])', 'g')
      const vorher = inhalt
      inhalt = inhalt.replace(muster, '$1' + neuName + '$2')
      if (inhalt !== vorher) geaendert = true
    }
    if (geaendert) await fs.writeFile(voll, inhalt, 'utf8')
  }

  for (const rel of buildDateien) {
    if (TEXT.has(path.extname(rel).toLowerCase())) await ersetzeInText(rel)
  }

  // --- jetzt physisch umbenennen ---
  for (const [alt, neu] of nameKarte) {
    const von = path.join(ziel, alt)
    const nach = path.join(ziel, neu)
    await fs.mkdir(path.dirname(nach), { recursive: true })
    await fs.rename(von, nach)
    bericht.umbenannt.push({ alt, neu })
  }

  // --- Schritt 6: Google-Maps und Videos als Hinweis ---
  for (const rel of buildDateien) {
    if (!/\.html?$/i.test(rel)) continue
    const inhalt = await fs.readFile(path.join(ziel, nameKarte.get(rel) || rel), 'utf8').catch(() => '')
    for (const url of eingebundeneUrls(inhalt)) {
      if (istKarteOderVideo(url)) {
        bericht.hinweise.push(`Externe Einbindung bleibt bestehen (${rel}): ${url.slice(0, 60)}… – lädt von einem fremden Server. Beim Livegang mit Cookie-Hinweis abdecken.`)
      }
    }
  }

  // (Einbacken läuft als Schritt 1b weiter oben – VOR Verkleinerung und
  //  Umbenennung, damit media/-Bilder mitoptimiert und Sidecar-Verweise
  //  vom Link-Nachzug erfasst werden.)
  return schreibeBerichtUndRaus(id, ziel, bericht, urlKarte, nameKarte)
}

// Rechnet den relativen Pfad von einer Datei zu einer Ziel-Datei im Build aus.
function relLink (vonDatei, zielRel) {
  const vonOrdner = path.dirname(vonDatei)
  let r = path.relative(vonOrdner, zielRel).split(path.sep).join('/')
  if (!r.startsWith('.')) r = './' + r
  return r
}

async function schreibeBerichtUndRaus (id, ziel, bericht, urlKarte, nameKarte) {
  await fs.writeFile(path.join(ziel, '.build-bericht.json'), JSON.stringify(bericht, null, 2), 'utf8')
  bericht.buildOrdner = ziel
  return bericht
}
