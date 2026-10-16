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

// Astra-Fund 39 (16.10.): HTML-Dateien auch in Unterordnern finden – Seiten
// in Sprachordnern (en/, fr/ …) wurden beim Einbacken sonst stumm übersprungen.
async function htmlRekursiv (wurzel, vor = '') {
  const raus = []
  let eintraege = []
  try { eintraege = await fs.readdir(path.join(wurzel, vor), { withFileTypes: true }) } catch { return raus }
  for (const e of eintraege) {
    const rel = vor ? vor + '/' + e.name : e.name
    if (e.isDirectory()) {
      if (/^(assets|media)$/i.test(e.name) || e.name.startsWith('.')) continue
      raus.push(...await htmlRekursiv(wurzel, rel))
    } else if (/\.html?$/i.test(e.name)) raus.push(rel)
  }
  return raus
}

// Ordnet einen Seitennamen («seite.html») nur zu, wenn es im Build genau
// EINE Datei dieses Namens gibt – sonst wäre die Zuordnung geraten.
function einzigerTreffer (liste, seite) {
  const passend = liste.filter(f => f.split('/').pop().toLowerCase() === seite)
  return passend.length === 1 ? passend[0] : null
}

export async function sidecarsEinbacken (quelle, ziel) {
  const bericht = {
    eingebackeneBilder: 0,
    zurLaufzeit: 0,        // statisch nicht auffindbar – läuft per Rest-Sidecar zur Laufzeit
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

  const buildHtml = await htmlRekursiv(ziel)

  for (const [seite, eintraege] of jeSeite) {
    // Astra-Fund 39 (16.10.): Seiten liegen auch in Sprachordnern (en/…) –
    // erst exakt, dann über den eindeutigen Dateinamen zuordnen.
    const datei = buildHtml.find(f => f.toLowerCase() === seite)
      || einzigerTreffer(buildHtml, seite)
    if (!datei) {
      bericht.probleme.push(`${seite}: Seite nicht im Build – ${eintraege.length} Justierung(en) übersprungen`)
      continue
    }
    let html = await fs.readFile(path.join(ziel, datei), 'utf8')
    const tags = [...html.matchAll(/<img\b[^>]*>/gi)]
    const ops = []
    // media/ liegt im Build-Stamm – Seiten in Unterordnern brauchen ../ davor.
    const tiefe = datei.split('/').length - 1

    const restLaufzeit = {}   // statisch nicht auffindbar -> Rest-Sidecar für die Laufzeit

    for (const { rest, wert } of eintraege) {
      if (wert.t && wert.t !== 'image') {
        bericht.probleme.push(`${seite}#${rest}: Typ «${wert.t}» wird noch nicht eingebacken`)
        continue
      }
      let pfad = wert.u
      if (DATA_URL.test(pfad)) pfad = await materialisieren(pfad)
      if (!pfad || /^data:/i.test(pfad)) {
        bericht.probleme.push(`${seite}#${rest}: Bilddaten unlesbar`)
        continue
      }
      const relPfad = /^(data:|https?:|\/)/i.test(pfad) ? pfad : '../'.repeat(tiefe) + pfad

      // Stufe 1: statisches <img> finden – per id oder globalem Index (Regex-Zählung).
      let treffer = null
      if (rest.startsWith('id:')) {
        // (?<![\w-]) statt \b: sonst träfe auch data-id="…" (Review-Fund 15).
        const muster = new RegExp('(?<![\\w-])id\\s*=\\s*["\']' + escRe(rest.slice(3)) + '["\']')
        treffer = tags.find(t => muster.test(t[0])) || null
      } else if (/^n\d+$/.test(rest)) {
        treffer = tags[Number(rest.slice(1))] || null
      }

      if (treffer) {
        // Tag chirurgisch umbauen: src ersetzen, Nachlade-Attribute entfernen,
        // damit nichts das eingebackene Bild wieder überstimmt.
        let tag = treffer[0]
          .replace(/\s(?:srcset|data-src|data-srcset|data-original|data-lazy)\s*=\s*"[^"]*"/gi, '')
          .replace(/\s(?:srcset|data-src|data-srcset|data-original|data-lazy)\s*=\s*'[^']*'/gi, '')
        // Review-Fund 15: Quote-Art respektieren (src="l'art.jpg" hat einen
        // Apostroph IM Wert) und den neuen Wert attributgerecht maskieren.
        const sicher = (q) => q === '"' ? relPfad.replace(/"/g, '&quot;') : relPfad.replace(/'/g, '&#39;')
        if (/\ssrc\s*=\s*"/i.test(tag)) {
          tag = tag.replace(/(\ssrc\s*=\s*")[^"]*(")/i, (g, a, b) => a + sicher('"') + b)
        } else if (/\ssrc\s*=\s*'/i.test(tag)) {
          tag = tag.replace(/(\ssrc\s*=\s*')[^']*(')/i, (g, a, b) => a + sicher("'") + b)
        } else {
          tag = tag.replace(/^<img/i, '<img src="' + sicher('"') + '"')
        }
        ops.push({ index: treffer.index, laenge: treffer[0].length, neu: tag })
        bericht.eingebackeneBilder++
        bericht.seiten.add(datei)
        continue
      }

      // Stufe 2: Das <img> entsteht erst zur Laufzeit (image-slot, JS-Galerie).
      // Steht der Original-Pfad GENAU EINMAL in der Seite, ersetzen wir ihn
      // dort – die Laufzeit baut dann von selbst mit dem neuen Bild.
      if (wert.orig && !/^data:/i.test(wert.orig)) {
        const vorkommen = html.split(wert.orig).length - 1
        if (vorkommen === 1) {
          ops.push({ index: html.indexOf(wert.orig), laenge: wert.orig.length, neu: relPfad })
          bericht.eingebackeneBilder++
          bericht.seiten.add(datei)
          continue
        }
      }

      // Stufe 3: nicht eindeutig zuordenbar – der Eintrag wandert in einen
      // Rest-Sidecar, den media-edit.js zur Laufzeit anwendet (ohne Brücke
      // automatisch schreibgeschützt).
      restLaufzeit[`${seite}#${rest}`] = { ...wert, u: pfad }
      bericht.zurLaufzeit++
    }

    // Von hinten nach vorn ersetzen, damit die Positionen stabil bleiben.
    ops.sort((a, b) => b.index - a.index)
    for (const op of ops) html = html.slice(0, op.index) + op.neu + html.slice(op.index + op.laenge)
    if (ops.length) await fs.writeFile(path.join(ziel, datei), html, 'utf8')

    if (Object.keys(restLaufzeit).length) {
      // Dateiname exakt so, wie media-edit.js ihn je Seite erwartet.
      const basis = seite.replace(/\.html?$/, '').replace(/[^a-z0-9_-]/g, '_')
      const name = `.media-edits-${basis}.state.json`
      await fs.writeFile(path.join(ziel, name), JSON.stringify(restLaufzeit), 'utf8')
      bericht.sidecars.push(name)
    }
  }

  // -------------------------------------------------------------------------
  // 2) Slot-, Scroll- und Frame-Sidecars mitliefern (Daten-URLs materialisiert)
  // -------------------------------------------------------------------------
  const mitliefern = quellDateien.filter(f =>
    /^\.(image-slots|scroll-shots)(-[a-z0-9_-]+)?\.state\.json$/.test(f) || f === '.frames.state.json')

  // Slot-Bilder wandern ins src-ATTRIBUT der Seiten (das akzeptiert die
  // Komponente immer – ihr Sicherheitsfilter verwirft relative Pfade aus dem
  // Sidecar). Im mitgelieferten Sidecar bleiben nur Zoom/Ausschnitt (s/x/y).
  // Genau dieses Verfahren sah auch das Original-Exportkonzept vor
  // («image-slot/scroll-shot -> src-Attribut einbacken»).
  const alleHtml = await htmlRekursiv(ziel)   // Astra-Fund 39: auch Sprachordner
  const htmlInhalte = new Map()
  for (const h of alleHtml) htmlInhalte.set(h, await fs.readFile(path.join(ziel, h), 'utf8'))

  function slotSrcSetzen (id, pfad, nurSeiten) {
    let getroffen = 0
    const muster = new RegExp(
      '<(image-slot|scroll-shot)\\b[^>]*(?<![\\w-])id\\s*=\\s*["\']' + escRe(id) + '["\'][^>]*>', 'gi')
    for (const [h, inhalt] of htmlInhalte) {
      // Review-Fund 16: Ein Seiten-Sidecar (.image-slots-SEITE.state.json)
      // ändert nur SEINE Seite – gleiche Slot-ids anderer Seiten bleiben in Ruhe.
      if (nurSeiten && !nurSeiten.includes(h)) continue
      // Relativer Pfad (media/…) muss von Unterordner-Seiten aus stimmen.
      const tiefe = h.split('/').length - 1
      const seitenPfad = /^(data:|https?:|\/)/i.test(pfad) ? pfad : '../'.repeat(tiefe) + pfad
      // Astra-Fund 28 (16.10.): Attributwert escapen – ein «"» im Sidecar
      // dürfte nie eigene Attribute (onerror=…) erzeugen.
      const sicherer = seitenPfad.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
      const neu = inhalt.replace(muster, (tag) => {
        getroffen++
        const ohne = tag.replace(/\ssrc\s*=\s*"[^"]*"/i, '').replace(/\ssrc\s*=\s*'[^']*'/i, '')
        return ohne.replace(/^<(image-slot|scroll-shot)\b/i, (m) => m + ' src="' + sicherer + '"')
      })
      if (neu !== inhalt) htmlInhalte.set(h, neu)
    }
    return getroffen
  }

  for (const f of mitliefern) {
    try {
      const obj = JSON.parse(await fs.readFile(path.join(quelle, f), 'utf8'))
      if (!obj || typeof obj !== 'object' || !Object.keys(obj).length) continue   // leere nicht mitschleppen
      const istSlotDatei = /^\.(image-slots|scroll-shots)/.test(f)
      const suffix = f.match(/^\.(?:image-slots|scroll-shots)-(.+)\.state\.json$/)
      const nurSeiten = suffix
        ? alleHtml.filter(h => h.split('/').pop().replace(/\.html?$/i, '').toLowerCase() === suffix[1].toLowerCase())
        : null
      for (const [id, wert] of Object.entries(obj)) {
        if (!wert || typeof wert !== 'object' || typeof wert.u !== 'string') continue
        let pfad = wert.u
        if (DATA_URL.test(pfad)) pfad = await materialisieren(pfad) || pfad
        if (istSlotDatei && !/^data:/i.test(pfad)) {
          const treffer = slotSrcSetzen(id, pfad, nurSeiten)
          if (treffer) {
            delete wert.u   // Bild sitzt jetzt im Attribut; s/x/y bleiben im Sidecar
            continue
          }
          bericht.probleme.push(`${f}: kein <…-slot id="${id}"> in den Seiten gefunden`)
        }
        wert.u = pfad
      }
      await fs.writeFile(path.join(ziel, f), JSON.stringify(obj), 'utf8')
      bericht.sidecars.push(f)
    } catch { bericht.probleme.push(f + ': unlesbar – nicht mitgeliefert') }
  }

  for (const [h, inhalt] of htmlInhalte) await fs.writeFile(path.join(ziel, h), inhalt, 'utf8')

  bericht.seiten = bericht.seiten.size
  return bericht
}
