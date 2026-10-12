// Vergleichs-Import: ein frisches Claude-Design-ZIP GEGEN das bestehende
// Projekt halten, statt es neu zu importieren.
//
// Ergebnis: vier Listen –
//   neu        im ZIP, aber nicht im Projekt      (z. B. impressum.html)
//   geaendert  in beiden, aber unterschiedlich
//   konflikte  geändert UND die LETZTE Änderung im Projekt war echte
//              Sitepilot-Arbeit (kein früheres Design-Update, kein Import) –
//              hier droht Überschreiben von Sitepilot-Arbeit, darum abgewählt
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

export async function vergleichErstellen (projektId, zipQuelle) {
  const wurzel = quellPfad(projektId)
  // zipQuelle: Buffer (Upload aus dem Browser) oder Pfad auf der Platte.
  const puffer = Buffer.isBuffer(zipQuelle) ? zipQuelle : await fs.readFile(zipQuelle)
  const zip = new AdmZip(puffer)
  const eintraege = zip.getEntries().filter(e => !e.isDirectory && !sollIgnoriert(e.entryName))
  if (!eintraege.length) throw new Error('Das ZIP enthält keine verwertbaren Dateien.')
  const wurzelOrdner = gemeinsamerWurzelordner(eintraege.map(e => e.entryName))

  const vorhandene = await quellDateien(wurzel)

  // Konflikt-Erkennung: Eine Datei ist nur dann ein Konflikt, wenn ihre
  // LETZTE Änderung echte Sitepilot-Arbeit war. Frühere Design-Updates und
  // der Import zählen nicht – sonst leuchtet nach dem zweiten Update ALLES
  // rot, obwohl Übernehmen völlig gefahrlos wäre (Mueller-Fund 12.10.).
  const repoDa = await istRepo(projektId)
  let ungesichert = new Set()
  if (repoDa) {
    try {
      const status = await git(projektId, ['status', '--porcelain'])
      ungesichert = new Set(status.split('\n').filter(Boolean)
        .map(z => z.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()))
    } catch { /* dann eben ohne */ }
  }
  async function istKonflikt (rel) {
    if (!repoDa) return false
    if (ungesichert.has(rel)) return true   // frische, noch ungesicherte Arbeit
    try {
      const betreff = (await git(projektId, ['log', '-1', '--format=%s', '--', rel])).trim()
      if (!betreff) return false            // Datei war noch nie im Verlauf
      return !/^(Design-Update aus|Import aus)/.test(betreff)
    } catch { return false }
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

    // Leere Editor-Arbeitsdateien ({} oder nichts) sind kein Übernahme-Kandidat –
    // sie würden die Liste nur mit Rauschen füllen.
    if (/^\./.test(path.basename(rel)) && daten.length <= 2) { gleich++; continue }

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
    else if (await istKonflikt(rel)) konflikte.push({ rel, bytes: daten.length })
    else geaendert.push({ rel, bytes: daten.length })
  }

  const geloescht = [...vorhandene.keys()]
    .filter(rel => !zipRel.has(rel) && !/^\./.test(path.basename(rel)))

  const manifest = {
    erstelltAm: new Date().toISOString(),
    zip: Buffer.isBuffer(zipQuelle) ? (arguments[2] || 'Upload.zip') : path.basename(zipQuelle),
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
