// Verwaltung der API-Schlüssel.
//
// Wichtig: Die Schlüssel liegen NICHT im Projektordner und nicht im Repo,
// sondern in deinem Benutzerverzeichnis unter ~/.sitepilot/keys.json mit
// Leserecht nur für dich (Modus 600). Dadurch kannst du Sitepilot weitergeben,
// ohne dass deine Schlüssel mitgehen – wer es bekommt, trägt seine eigenen ein.
//
// Zum Browser gehen die Schlüssel nie zurück, nur eine maskierte Anzeige.

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const ORDNER = path.join(os.homedir(), '.sitepilot')
const DATEI = path.join(ORDNER, 'keys.json')
const ALT_DATEI = path.join(os.homedir(), '.vinweb', 'keys.json')

// Einmalige Übernahme aus Sitepilot-Zeiten: Liegt die alte Schlüsseldatei noch
// unter ~/.sitepilot, wird sie beim ersten Zugriff nach ~/.sitepilot kopiert.
async function alteAblageUebernehmen () {
  try {
    await fs.access(DATEI)
  } catch {
    try {
      const alt = await fs.readFile(ALT_DATEI)
      await fs.mkdir(ORDNER, { recursive: true, mode: 0o700 })
      await fs.writeFile(DATEI, alt, { mode: 0o600 })
    } catch { /* keine alte Ablage – nichts zu übernehmen */ }
  }
}

// "github" ist kein KI-Anbieter, sondern das Zugangstoken zum Fernlager
// (Sync der Kundenwebsites) - gleiche sichere Ablage, gleiche Verwaltung.
export const ANBIETER = ['anthropic', 'openai', 'github']

let migrationGeprueft = false
async function lesen () {
  if (!migrationGeprueft) { migrationGeprueft = true; await alteAblageUebernehmen() }
  try {
    return JSON.parse(await fs.readFile(DATEI, 'utf8'))
  } catch {
    return {}
  }
}

async function schreiben (daten) {
  await fs.mkdir(ORDNER, { recursive: true, mode: 0o700 })
  await fs.writeFile(DATEI, JSON.stringify(daten, null, 2), { mode: 0o600 })
  // Auch bei einer bereits bestehenden Datei die Rechte erzwingen.
  await fs.chmod(DATEI, 0o600)
}

export async function schluesselHolen (anbieter) {
  const daten = await lesen()
  const wert = daten[anbieter]
  return typeof wert === 'string' && wert.trim() ? wert.trim() : null
}

export async function schluesselSetzen (anbieter, wert) {
  if (!ANBIETER.includes(anbieter)) throw new Error('Unbekannter Anbieter.')
  const daten = await lesen()
  const sauber = String(wert || '').trim()
  if (sauber) daten[anbieter] = sauber
  else delete daten[anbieter]
  await schreiben(daten)
}

// Zeigt nur an, ob ein Schlüssel da ist – und ein paar Zeichen zum Wiedererkennen.
function maskieren (wert) {
  if (!wert) return null
  if (wert.length <= 12) return wert.slice(0, 3) + '…'
  return wert.slice(0, 7) + '…' + wert.slice(-4)
}

export async function schluesselUebersicht () {
  const daten = await lesen()
  const ergebnis = {}
  for (const a of ANBIETER) {
    ergebnis[a] = {
      gesetzt: Boolean(daten[a]),
      maskiert: maskieren(daten[a]),
    }
  }
  ergebnis.datei = DATEI
  return ergebnis
}
