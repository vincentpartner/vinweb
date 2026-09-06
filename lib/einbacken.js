// Einbacken der Editor-Justierungen in den Build.
//
// Im Arbeitsstand leben Bild-Ersetzungen und Justierungen in .state.json-
// Sidecars (gleiches Prinzip wie in Claude Design). Für den Live-Stand gilt:
//
//   1. media-edits (ersetzte <img>-Bilder) werden FEST eingebacken:
//      Daten-URLs werden zu echten Dateien unter media/, das src-Attribut
//      zeigt darauf. Ergebnis: normale, schnelle <img> ohne Laufzeit-Magie.
//      Die Schlüssel sind dafür gebaut («seite#n<Index>» zählt alle <img>
//      per Regex in Dokumentreihenfolge – exakt so zählen wir hier).
//
//   2. image-slots, scroll-shots und frames werden als kleine Sidecars
//      MITGELIEFERT (Daten-URLs darin ebenfalls materialisiert): Ihre
//      Komponenten rendern Zoom/Ausschnitt/Seitenverhältnis pixelgenau
//      selbst und sind ohne Editor-Brücke automatisch schreibgeschützt –
//      dasselbe Modell wie Claude-Design-Share-Links. So müssen wir deren
//      Justier-Mathematik nicht nachbauen (und können sie nicht verfälschen).

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const DATA_URL = /^data:([a-z]+\/[a-z0-9+.-]+);base64,/i

const ENDUNG = {
  'image/png': '.png', 'image/webp': '.webp', 'image/jpeg': '.jpg',
  'image/jpg': '.jpg', 'image/gif': '.gif', 'image/svg+xml': '.svg',
  'video/mp4': '.mp4', 'video/webm': '.webm',
}

const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export async function sidecarsEinbacken (quelle, ziel) {
  const bericht = {
    eingebackeneBilder: 0,
    seiten: new Set(),
    sidecars: [],
    mediaDateien: 0,
    mediaBytes: 0,
    probleme: [],
  }

  const mediaOrdner = path.join(ziel, 'media')
  const geschrieben = new Map()   // Inhalts-Hash -> Dateiname (dedupliziert)

  async function materialisieren (u) {
    const m = u.match(DATA_URL)
    if (!m) return null
    const daten = Buffer.from(u.slice(u.indexOf(',') + 1), 'base64')
    const hash = crypto.createHash('sha1').update(daten).digest('hex').slice(0, 12)
    if (!geschrieben.has(hash)) {
      const name = hash + (ENDUNG[m[1].toLowerCase()] || '.bin')
      await fs.mkdir(mediaOrdner, { recursive: true })
      await fs.writeFile(path.join(mediaOrdner, name), daten)
      geschrieben.set(hash, name)
      bericht.mediaDateien++
      bericht.mediaBytes += daten.length
    }
    return 'media/' + geschrieben.get(hash)
  }

  const quellDateien = await fs.readdir(quelle)

  // -------------------------------------------------------------------------
  // 1) media-edits fest einbacken
  // -------------------------------------------------------------------------
  const store = {}
  for (const f of quellDateien.filter(f => /^\.media-edits.*\.state\.json$/.test(f))) {
    try {
      Object.assign(store, JSON.parse(await fs.readFile(path.join(quelle, f), 'utf8')))
    } catch { bericht.probleme.push(f + ': unlesbar – übersprungen') }
  }

  // Einträge nach Seite gruppieren. Schlüssel: "seite.html#n3" oder "seite.html#id:foo"
  const jeSeite = new Map()
  for (const [schluessel, wert] of Object.entries(store)) {
    if (!wert || typeof wert !== 'object' || !wert.u) continue   // null = zurückgesetzt
    const t = schluessel.indexOf('#')
    if (t < 1) continue
    const seite = schluessel.slice(0, t).toLowerCase()
    if (!jeSeite.has(seite)) jeSeite.set(seite, [])
    jeSeite.get(seite).push({ rest: schluessel.slice(t + 1), wert })
  }

  const buildHtml = (await fs.readdir(ziel)).filter(f => /\.html?$/i.test(f))

  for (const [seite, eintraege] of jeSeite) {
    const datei = buildHtml.find(f => f.toLowerCase() === seite)
    if (!datei) {
      bericht.probleme.push(`${seite}: Seite nicht im Build – ${eintraege.length} Justierung(en) übersprungen`)
      continue
    }
    let html = await fs.readFile(path.join(ziel, datei), 'utf8')
    const tags = [...html.matchAll(/<img\b[^>]*>/gi)]
    const ops = []

    for (const { rest, wert } of eintraege) {
      if (wert.t && wert.t !== 'image') {
        bericht.probleme.push(`${seite}#${rest}: Typ «${wert.t}» wird noch nicht eingebacken`)
        continue
      }
      // Ziel-Bild finden: per id oder per globalem Index (Regex-Zählung).
      let treffer = null
      if (rest.startsWith('id:')) {
        const muster = new RegExp('\\bid\\s*=\\s*["\']' + escRe(rest.slice(3)) + '["\']')
        treffer = tags.find(t => muster.test(t[0])) || null
      } else if (/^n\d+$/.test(rest)) {
        treffer = tags[Number(rest.slice(1))] || null
      }
      if (!treffer) {
        bericht.probleme.push(`${seite}#${rest}: kein passendes <img> gefunden – Seite verändert?`)
        continue
      }

      let pfad = wert.u
      if (DATA_URL.test(pfad)) pfad = await materialisieren(pfad)
      if (!pfad || /^data:/i.test(pfad)) {
        bericht.probleme.push(`${seite}#${rest}: Bilddaten unlesbar`)
        continue
      }

      // Tag chirurgisch umbauen: src ersetzen, Nachlade-Attribute entfernen,
      // damit nichts das eingebackene Bild wieder überstimmt.
      let tag = treffer[0]
        .replace(/\s(?:srcset|data-src|data-srcset|data-original|data-lazy)\s*=\s*"[^"]*"/gi, '')
        .replace(/\s(?:srcset|data-src|data-srcset|data-original|data-lazy)\s*=\s*'[^']*'/gi, '')
      tag = /\ssrc\s*=\s*["']/.test(tag)
        ? tag.replace(/(\ssrc\s*=\s*["'])[^"']*(["'])/i, '$1' + pfad + '$2')
        : tag.replace(/^<img/i, '<img src="' + pfad + '"')

      ops.push({ index: treffer.index, laenge: treffer[0].length, neu: tag })
      bericht.eingebackeneBilder++
      bericht.seiten.add(datei)
    }

    // Von hinten nach vorn ersetzen, damit die Positionen stabil bleiben.
    ops.sort((a, b) => b.index - a.index)
    for (const op of ops) html = html.slice(0, op.index) + op.neu + html.slice(op.index + op.laenge)
    if (ops.length) await fs.writeFile(path.join(ziel, datei), html, 'utf8')
  }

  // -------------------------------------------------------------------------
  // 2) Slot-, Scroll- und Frame-Sidecars mitliefern (Daten-URLs materialisiert)
  // -------------------------------------------------------------------------
  const mitliefern = quellDateien.filter(f =>
    /^\.(image-slots|scroll-shots)(-[a-z0-9_-]+)?\.state\.json$/.test(f) || f === '.frames.state.json')

  for (const f of mitliefern) {
    try {
      const obj = JSON.parse(await fs.readFile(path.join(quelle, f), 'utf8'))
      if (!obj || typeof obj !== 'object' || !Object.keys(obj).length) continue   // leere nicht mitschleppen
      for (const wert of Object.values(obj)) {
        if (wert && typeof wert === 'object' && typeof wert.u === 'string' && DATA_URL.test(wert.u)) {
          const p = await materialisieren(wert.u)
          if (p) wert.u = p
        }
      }
      await fs.writeFile(path.join(ziel, f), JSON.stringify(obj), 'utf8')
      bericht.sidecars.push(f)
    } catch { bericht.probleme.push(f + ': unlesbar – nicht mitgeliefert') }
  }

  bericht.seiten = bericht.seiten.size
  return bericht
}
