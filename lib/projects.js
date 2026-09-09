// Verwaltung der Projekte: anlegen, auflisten, Pfade auflösen.
//
// Ein Projekt liegt unter  projects/<id>/  und hat diesen Aufbau:
//
//   projects/new-vincent/
//     projekt.json     Stammdaten (Name, Importdatum, Analysebericht)
//     source/          die entpackten Dateien der Website
//
// Später kommen dazu:  build/  (Produktionsstand)  und  .git/  (Versionen).

import fs from 'node:fs/promises'
import path from 'node:path'
import { PROJECTS_DIR } from './config.js'

// Macht aus "New Vincent (3).zip" die Kennung "new-vincent-3".
export function zuKennung (text) {
  return String(text)
    .replace(/\.zip$/i, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Umlaute entschärfen
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'projekt'
}

export function projektPfad (id) {
  // Review-Fund 12: Kennungen strikt prüfen – basename() allein liesse
  // z. B. ".." durch. Erlaubt ist nur, was zuKennung() je erzeugt.
  const sauber = String(id)
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(sauber)) {
    throw new Error('Ungültige Projekt-Kennung.')
  }
  return path.join(PROJECTS_DIR, sauber)
}

export function quellPfad (id) {
  return path.join(projektPfad(id), 'source')
}

export async function projektLesen (id) {
  try {
    const roh = await fs.readFile(path.join(projektPfad(id), 'projekt.json'), 'utf8')
    return JSON.parse(roh)
  } catch {
    return null
  }
}

export async function projektSchreiben (id, daten) {
  await fs.mkdir(projektPfad(id), { recursive: true })
  await fs.writeFile(
    path.join(projektPfad(id), 'projekt.json'),
    JSON.stringify(daten, null, 2),
    'utf8'
  )
}

export async function projekteAuflisten () {
  await fs.mkdir(PROJECTS_DIR, { recursive: true })
  const eintraege = await fs.readdir(PROJECTS_DIR, { withFileTypes: true })
  const liste = []
  for (const e of eintraege) {
    if (!e.isDirectory()) continue
    const daten = await projektLesen(e.name)
    if (daten) liste.push(daten)
  }
  // Neueste zuerst.
  liste.sort((a, b) => String(b.importiertAm).localeCompare(String(a.importiertAm)))
  return liste
}

// Findet eine noch freie Kennung, damit ein zweiter Import ein bestehendes
// Projekt nicht ueberschreibt.
export async function freieKennung (basis) {
  // Review-Fund 10: Die Kennung wird ATOMAR reserviert (mkdir schlägt fehl,
  // wenn es den Ordner schon gibt) – zwei gleichzeitige Importe können nicht
  // mehr dieselbe Kennung bekommen.
  let n = 1
  while (true) {
    const id = n === 1 ? zuKennung(basis) : `${zuKennung(basis)}-${n}`
    try {
      await fs.mkdir(projektPfad(id), { recursive: false })
      return id
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      n++
    }
  }
}
