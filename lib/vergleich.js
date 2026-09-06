// Vergleichs-Import: ein frisches Claude-Design-ZIP GEGEN das bestehende
// Projekt halten, statt es neu zu importieren.
//
// Ergebnis: vier Listen –
//   neu        im ZIP, aber nicht im Projekt      (z. B. impressum.html)
//   geaendert  in beiden, aber unterschiedlich
//   konflikte  geändert UND seit dem Import auch in VinWeb angefasst –
//              hier droht Überschreiben von VinWeb-Arbeit, darum abgewählt
//   geloescht  im Projekt, aber nicht mehr im ZIP (nur Anzeige, kein Auto-Löschen)
//
// Die Kandidaten werden nach projects/<id>/vergleich/ entpackt; übernommen
// wird erst nach Auswahl – als eigener Verlaufs-Stand.

import fs from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { projektPfad, quellPfad } from './projects.js'
import { sollIgnoriert, istGefaehrlich, gemeinsamerWurzelordner } from './importer.js'
import { git, istRepo } from './git.js'

export function vergleichOrdner (id) {
  return path.join(projektPfad(id), 'vergleich')
}

async function quellDateien (wurzel) {
  const raus = new Map()
  async function ab (ordner) {
    for (const e of await fs.readdir(ordner, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const voll = path.join(ordner, e.name)
      if (e.isDirectory()) await ab(voll)
      else raus.set(path.relative(wurzel, voll).split(path.sep).join('/'), voll)
    }
  }
  await ab(wurzel)
  return raus
}

export async function vergleichErstellen (projektId, zipPfad) {
  const wurzel = quellPfad(projektId)
  const zip = new AdmZip(await fs.readFile(zipPfad))
  const eintraege = zip.getEntries().filter(e => !e.isDirectory && !sollIgnoriert(e.entryName))
  if (!eintraege.length) throw new Error('Das ZIP enthält keine verwertbaren Dateien.')
  const wurzelOrdner = gemeinsamerWurzelordner(eintraege.map(e => e.entryName))

  const vorhandene = await quellDateien(wurzel)

  // Seit dem Import in VinWeb geänderte Dateien (für die Konflikt-Erkennung).
  let inVinWebGeaendert = new Set()
  if (await istRepo(projektId)) {
    try {
      const erster = (await git(projektId, ['rev-list', '--max-parents=0', 'HEAD'])).trim().split('\n')[0]
      const liste = await git(projektId, ['diff', '--name-only', erster + '..HEAD'])
      inVinWebGeaendert = new Set(liste.split('\n').filter(Boolean))
    } catch { /* ohne Verlauf keine Konflikt-Erkennung */ }
  }

  const ziel = vergleichOrdner(projektId)
  await fs.rm(ziel, { recursive: true, force: true })
  await fs.mkdir(ziel, { recursive: true })

  const neu = []
  const geaendert = []
  const konflikte = []
  let gleich = 0
  const zipRel = new Set()

  for (const e of eintraege) {
    let rel = wurzelOrdner ? e.entryName.slice(wurzelOrdner.length + 1) : e.entryName
    if (!rel || istGefaehrlich(rel)) continue
    zipRel.add(rel)
    const daten = e.getData()

    const quellVoll = vorhandene.get(rel)
    if (quellVoll) {
      const alt = await fs.readFile(quellVoll)
      if (alt.equals(daten)) { gleich++; continue }
    }

    // Kandidat: nach vergleich/ entpacken
    const kandidat = path.join(ziel, rel)
    await fs.mkdir(path.dirname(kandidat), { recursive: true })
    await fs.writeFile(kandidat, daten)

    if (!quellVoll) neu.push({ rel, bytes: daten.length })
    else if (inVinWebGeaendert.has(rel)) konflikte.push({ rel, bytes: daten.length })
    else geaendert.push({ rel, bytes: daten.length })
  }

  const geloescht = [...vorhandene.keys()]
    .filter(rel => !zipRel.has(rel) && !/^\./.test(path.basename(rel)))

  const manifest = {
    erstelltAm: new Date().toISOString(),
    zip: path.basename(zipPfad),
    neu, geaendert, konflikte, geloescht, gleich,
  }
  await fs.writeFile(path.join(ziel, '.manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return manifest
}

export async function vergleichUebernehmen (projektId, gewaehlt) {
  const ziel = vergleichOrdner(projektId)
  const manifest = JSON.parse(await fs.readFile(path.join(ziel, '.manifest.json'), 'utf8'))
  const erlaubt = new Set([...manifest.neu, ...manifest.geaendert, ...manifest.konflikte].map(x => x.rel))

  const wurzel = quellPfad(projektId)
  const uebernommen = []
  for (const relRoh of gewaehlt || []) {
    const rel = String(relRoh)
    if (!erlaubt.has(rel) || istGefaehrlich(rel)) continue
    const von = path.join(ziel, rel)
    const nach = path.join(wurzel, rel)
    if (!path.resolve(nach).startsWith(path.resolve(wurzel) + path.sep)) continue
    await fs.mkdir(path.dirname(nach), { recursive: true })
    await fs.copyFile(von, nach)
    uebernommen.push(rel)
  }
  await fs.rm(ziel, { recursive: true, force: true })
  return { uebernommen, zip: manifest.zip }
}
