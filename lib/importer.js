// Import eines ZIP-Archivs in ein neues Projekt.
//
// Wichtig ist hier vor allem eines: Ein ZIP ist eine fremde Datei. Wir behandeln
// jeden Eintrag darin als möglicherweise bösartig und prüfen jeden Pfad,
// bevor wir etwas auf die Festplatte schreiben.

import fs from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { quellPfad, projektPfad, freieKennung, projektSchreiben } from './projects.js'

// Diese Einträge legt macOS in jedes ZIP - sie gehören nie ins Projekt.
const IGNORIEREN = [
  /^__MACOSX\//,
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/i,
  /(^|\/)\._[^/]+$/,         // macOS-Ressourcendateien
  // Ein .git-Ordner aus einem fremden ZIP wird NIE entpackt. Git führt Hooks
  // und Einträge aus .git/config aus – ein präpariertes Archiv könnte darüber
  // beliebigen Code auf diesem Rechner starten, sobald VinWeb sichert.
  /(^|\/)\.git(\/|$)/i
]

export function sollIgnoriert (name) {
  return IGNORIEREN.some(r => r.test(name))
}

// Prüft, ob ein Eintragsname aus dem Zielordner ausbrechen will.
// Ein Angreifer koennte "../../../../etc/passwd" in ein ZIP legen -
// dieser Trick heisst "Zip Slip" und wird hier abgefangen.
export function istGefaehrlich (name) {
  if (path.isAbsolute(name)) return true
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return true
  return name.split(/[/\\]/).includes('..')
}

// Viele Exporte packen alles in einen einzigen Oberordner. Den entfernen wir,
// damit index.html direkt in source/ liegt und nicht in source/irgendwas/.
export function gemeinsamerWurzelordner (namen) {
  if (namen.length < 2) return null
  const ersteSegmente = new Set(namen.map(n => n.split('/')[0]))
  if (ersteSegmente.size !== 1) return null
  const kandidat = [...ersteSegmente][0]
  // Nur entfernen, wenn wirklich alle Einträge tiefer liegen.
  if (namen.some(n => n === kandidat || !n.startsWith(kandidat + '/'))) return null
  return kandidat
}

/**
 * Entpackt ein ZIP in ein neues Projekt.
 * @param {Buffer} puffer  Inhalt der ZIP-Datei
 * @param {string} dateiname  urspruenglicher Name, dient als Projektname
 * @returns {Promise<{id:string, name:string, dateien:number, bytes:number, uebersprungen:string[]}>}
 */
export async function zipImportieren (puffer, dateiname) {
  const zip = new AdmZip(puffer)
  const alle = zip.getEntries()

  const nutzbar = alle.filter(e => !e.isDirectory && !sollIgnoriert(e.entryName))
  if (nutzbar.length === 0) {
    throw new Error('Das ZIP enthält keine verwertbaren Dateien.')
  }

  const wurzel = gemeinsamerWurzelordner(nutzbar.map(e => e.entryName))

  const id = await freieKennung(dateiname)
  const ziel = quellPfad(id)
  await fs.mkdir(ziel, { recursive: true })

  let bytes = 0
  let geschrieben = 0
  const uebersprungen = []

  for (const eintrag of nutzbar) {
    let name = eintrag.entryName
    if (wurzel) name = name.slice(wurzel.length + 1)

    if (istGefaehrlich(name)) {
      uebersprungen.push(name)
      continue
    }

    const zielDatei = path.join(ziel, name)

    // Doppelte Absicherung: der aufgeloeste Pfad muss innerhalb von source/ liegen.
    const innerhalb = path.resolve(zielDatei).startsWith(path.resolve(ziel) + path.sep)
    if (!innerhalb) {
      uebersprungen.push(name)
      continue
    }

    await fs.mkdir(path.dirname(zielDatei), { recursive: true })
    const daten = eintrag.getData()
    await fs.writeFile(zielDatei, daten)
    bytes += daten.length
    geschrieben++
  }

  const name = String(dateiname).replace(/\.zip$/i, '')
  await projektSchreiben(id, {
    id,
    name,
    quellDatei: dateiname,
    importiertAm: new Date().toISOString(),
    dateien: geschrieben,
    bytes,
    uebersprungen
  })

  return { id, name, dateien: geschrieben, bytes, uebersprungen }
}

// Loescht ein Projekt vollstaendig.
export async function projektLoeschen (id) {
  const ordner = projektPfad(id)
  // Sicherheitsnetz: nur loeschen, was auch wirklich unter projects/ liegt.
  const { PROJECTS_DIR } = await import('./config.js')
  if (!path.resolve(ordner).startsWith(path.resolve(PROJECTS_DIR) + path.sep)) {
    throw new Error('Ungültiger Projektpfad.')
  }
  await fs.rm(ordner, { recursive: true, force: true })
}
