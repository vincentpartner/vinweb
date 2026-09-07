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

function zielPruefen (deploy, art) {
  if (!deploy?.host || !deploy?.[art]) {
    throw new Error(`Kein ${art === 'staging' ? 'Staging' : 'Live'}-Ziel eingerichtet – `
      + 'in projekt.json unter "deploy" hinterlegen (macht Claude beim Einrichten).')
  }
  // Nur einfache, erwartbare Formen zulassen – keine Optionen, keine Tricks.
  if (!/^[a-z0-9._-]+@[a-z0-9.-]+$/i.test(deploy.host)) throw new Error('Deploy-Host hat ein unerwartetes Format.')
  if (!/^[a-z0-9._\/-]+$/i.test(deploy[art]) || deploy[art].includes('..')) throw new Error('Deploy-Pfad hat ein unerwartetes Format.')
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
  const { stdout } = await lauf('rsync', [
    '-az', '--delete', '--itemize-changes',
    '--exclude', '.build-bericht.json',
    quelle + '/', ziel,
  ], { timeout: 300000, maxBuffer: 16 * 1024 * 1024 })
  const uebertragen = stdout.split('\n').filter(z => /^[<>]/.test(z)).length

  if (art === 'staging') {
    onMeldung('Setze Staging-Schutz (Suchmaschinen aussperren) …')
    const schutz = 'cd ' + deploy[art].replace(/'/g, '') + ' && '
      + 'printf "User-agent: *\\nDisallow: /\\n" > robots.txt && '
      + 'grep -q X-Robots-Tag .htaccess 2>/dev/null || '
      + 'printf "\\n# STAGING: nicht indexieren\\n<IfModule mod_headers.c>\\n  Header set X-Robots-Tag \\"noindex, nofollow\\"\\n</IfModule>\\n" >> .htaccess'
    await lauf('ssh', ['-o', 'BatchMode=yes', deploy.host, schutz], { timeout: 60000 })
  }

  return {
    art,
    uebertragen,
    url: art === 'staging' ? (deploy.stagingUrl || '') : (deploy.liveUrl || ''),
    am: new Date().toISOString(),
  }
}
