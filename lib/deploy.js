// Etappe 6 – Deploy: den fertigen Build per rsync über SSH auf den Server stellen.
//
// Ziele stehen je Projekt in projekt.json unter "deploy":
//   { host: 'benutzer@server', staging: 'pfad/auf/dem/server', stagingUrl: '…',
//     live: '', liveUrl: '' }
//
// Staging bekommt IMMER automatisch den Suchmaschinen-Schutz (robots.txt
// Disallow + X-Robots-Tag) – bei jedem Deploy neu gesetzt, damit ihn kein
// frischer Build wegputzt. Live bekommt ihn NIE.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildPfad } from './build.js'

const lauf = promisify(execFile)

// Wiederverwendbare Formatregeln – auch der Einrichtungs-Endpunkt nutzt sie.
export function hostGueltig (host) {
  return /^[a-z0-9._-]+@[a-z0-9.-]+$/i.test(String(host || ''))
}
export function pfadGueltig (pfad) {
  const p = String(pfad || '')
  return /^[a-z0-9._\/-]+$/i.test(p) && !p.includes('..') && !p.startsWith('/')
}

function zielPruefen (deploy, art) {
  if (!deploy?.host || !deploy?.[art]) {
    throw new Error(`Kein ${art === 'staging' ? 'Staging' : 'Live'}-Ziel eingerichtet – `
      + 'in projekt.json unter "deploy" hinterlegen (macht Claude beim Einrichten).')
  }
  // Nur einfache, erwartbare Formen zulassen – keine Optionen, keine Tricks.
  if (!/^[a-z0-9._-]+@[a-z0-9.-]+$/i.test(deploy.host)) throw new Error('Deploy-Host hat ein unerwartetes Format.')
  // Review-Fund 3: gefährlich breite Ziele (".", "/", ein einzelnes Segment)
  // werden abgelehnt – verlangt ist ein echtes Unterverzeichnis.
  const zielPfad = deploy[art]
  if (zielPfad.includes('..') || zielPfad.startsWith('/')
    || !/^[a-z0-9._-]+(\/[a-z0-9._-]+)+$/i.test(zielPfad)) {
    throw new Error('Deploy-Pfad muss ein Unterverzeichnis sein (z. B. public_html/example.ch).')
  }
}

export async function deployAusfuehren (projekt, art, onMeldung = () => {}) {
  const deploy = projekt.deploy
  zielPruefen(deploy, art)

  const quelle = buildPfad(projekt.id)
  try { await fs.access(path.join(quelle, 'index.html')) } catch {
    throw new Error('Kein Build vorhanden – bitte zuerst unter «Build» erzeugen.')
  }

  const ziel = `${deploy.host}:${deploy[art]}/`
  onMeldung(`Übertrage Build nach ${art} …`)
  // Review-Fund 3: Dateien, die NUR auf dem Server leben (Konfigurationen,
  // Laufzeitdaten), überleben das --delete. Standardschutz + je Projekt
  // erweiterbar über deploy.schuetzen (Liste von rsync-Mustern).
  const geschuetzt = ['kalender/config.php', 'config.php', '.well-known/***',
    ...(Array.isArray(deploy.schuetzen) ? deploy.schuetzen : [])]
  const filter = geschuetzt.flatMap(g => ['--filter', 'P ' + g])
  const { stdout } = await lauf('rsync', [
    '-az', '--delete', '--itemize-changes',
    '--exclude', '.build-bericht.json',
    ...filter,
    quelle + '/', ziel,
  ], { timeout: 300000, maxBuffer: 16 * 1024 * 1024 })
  const uebertragen = stdout.split('\n').filter(z => /^[<>]/.test(z)).length

  return {
    art,
    uebertragen,
    url: art === 'staging' ? (deploy.stagingUrl || '') : (deploy.liveUrl || ''),
    am: new Date().toISOString(),
  }
}

// Review-Fund 17: Der Staging-Schutz wird VOR der Übertragung in den lokalen
// Build geschrieben – kein SSH-Nachschritt mehr, kein Zeitfenster ohne Schutz,
// kein Erfolg trotz fehlgeschlagenem cd. Der Live-Deploy baut immer frisch,
// darum verseucht das den Live-Stand nicht.
export async function stagingSchutzEinbetten (buildOrdner) {
  await fs.writeFile(path.join(buildOrdner, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8')
  const ht = path.join(buildOrdner, '.htaccess')
  let inhalt = ''
  try { inhalt = await fs.readFile(ht, 'utf8') } catch { /* dann neu anlegen */ }
  if (!inhalt.includes('X-Robots-Tag')) {
    inhalt += '\n# STAGING: nicht indexieren\n<IfModule mod_headers.c>\n  Header set X-Robots-Tag "noindex, nofollow"\n</IfModule>\n'
    await fs.writeFile(ht, inhalt, 'utf8')
  }
}

