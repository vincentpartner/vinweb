// Das Sicherheitsnetz: jedes Projekt bekommt ein eigenes Git-Repo.
//
// Warum Git und keine eigene Lösung?
//   - Ein Stand = der komplette Projektzustand, nicht nur einzelne Dateien.
//     Auch gelöschte Dateien kommen beim Zurücksetzen wieder.
//   - Unveränderte Dateien kosten keinen zusätzlichen Platz. Ein 33-MB-Projekt
//     bleibt auch nach hunderten Ständen bei rund 35 MB.
//   - Es ist dasselbe System, das später nach GitHub geht – eines statt zwei.
//
// Wichtigste Regel: Zurücksetzen löscht NIE etwas. Der alte Stand wird als
// neuer Stand obendrauf geschrieben. Damit ist auch das Zurücksetzen
// zurücksetzbar.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { quellPfad } from './projects.js'
import { schluesselHolen } from './keys.js'

const ausfuehren = promisify(execFile)

// Trennzeichen für die Verlaufsausgabe – Zeichen, die in Texten nicht vorkommen.
const SATZ = '\x01'
const FELD = '\x1f'

async function git (id, argumente, optionen = {}) {
  const cwd = quellPfad(id)
  // Wiederholversuch bei index.lock: VinWeb und Mini/Midi schreiben in
  // DASSELBE Repo. Committen beide im selben Moment, haelt Git kurz die
  // Sperre - dann ist Warten und Nochmals-Versuchen die richtige Antwort.
  for (let versuch = 1; ; versuch++) {
    try {
      const { stdout } = await ausfuehren('git', argumente, {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        ...optionen,
      })
      return stdout
    } catch (e) {
      if (versuch < 4 && /index\.lock/.test(String(e.stderr || ''))) {
        await new Promise(r => setTimeout(r, 300 * versuch))
        continue
      }
      throw e
    }
  }
}

export async function gitVorhanden () {
  try {
    await ausfuehren('git', ['--version'])
    return true
  } catch {
    return false
  }
}

export async function istRepo (id) {
  try {
    await fs.access(path.join(quellPfad(id), '.git'))
    return true
  } catch {
    return false
  }
}

// Wer als Urheber eingetragen wird. Ist global nichts gesetzt, nimmt VinWeb
// einen neutralen Namen – sonst verweigert Git den ersten Stand.
async function urheber () {
  const lesen = async (feld) => {
    try {
      const { stdout } = await ausfuehren('git', ['config', '--global', feld])
      return stdout.trim()
    } catch {
      return ''
    }
  }
  const name = (await lesen('user.name')) || 'VinWeb'
  const mail = (await lesen('user.email')) || 'vinweb@localhost'
  return ['-c', `user.name=${name}`, '-c', `user.email=${mail}`]
}

// ---------------------------------------------------------------------------
// Ausschlussliste
// ---------------------------------------------------------------------------

// Baut die .gitignore aus den Häkchen in "Was gehört wohin".
// Ein Eintrag ohne Häkchen bei "Repo" wird nicht versioniert – das Häkchen
// bedeutet damit wörtlich: gesichert und wiederherstellbar.
export function gitignoreText (projekt) {
  const zeilen = [
    '# Von VinWeb erzeugt – gesteuert über die Häkchen im Reiter "Was gehört wohin".',
    '',
    '.DS_Store',
    'Thumbs.db',
    'node_modules/',
    '',
  ]
  const auswahl = projekt.auswahl || {}
  const struktur = projekt.analyse?.struktur || []
  const ausgeschlossen = []

  for (const eintrag of struktur) {
    const repo = auswahl[eintrag.name]?.repo ?? eintrag.repo
    if (!repo) ausgeschlossen.push(eintrag.name + (eintrag.istOrdner ? '/' : ''))
  }
  // Einzelne Dateien mit Zugangsdaten innerhalb erlaubter Ordner.
  for (const eintrag of struktur) {
    for (const geheim of eintrag.zugangsdaten || []) {
      if (!ausgeschlossen.includes(geheim)) ausgeschlossen.push(geheim)
    }
  }

  if (ausgeschlossen.length) {
    zeilen.push('# Nicht versioniert:')
    zeilen.push(...ausgeschlossen.sort())
  }
  return zeilen.join('\n') + '\n'
}

export async function gitignoreAnwenden (id, projekt) {
  const datei = path.join(quellPfad(id), '.gitignore')
  const neu = gitignoreText(projekt)
  let alt = null
  try { alt = await fs.readFile(datei, 'utf8') } catch { /* gibt es noch nicht */ }
  if (alt === neu) return false

  await fs.writeFile(datei, neu, 'utf8')

  // Was neu ausgeschlossen wurde, aber schon versioniert war, aus der
  // Verfolgung nehmen – sonst ignoriert Git die Ausschlussliste dafür.
  if (await istRepo(id)) {
    try {
      await git(id, ['rm', '-r', '--cached', '--ignore-unmatch', '-q', '.'])
      await git(id, ['add', '-A'])
    } catch { /* im leeren Repo nicht nötig */ }
  }
  return true
}

// ---------------------------------------------------------------------------
// Anlegen und sichern
// ---------------------------------------------------------------------------

export async function repoAnlegen (id, projekt) {
  if (await istRepo(id)) return false
  await git(id, ['init', '-q', '-b', 'main'])
  await gitignoreAnwenden(id, projekt)
  await sichern(id, 'Import aus ' + (projekt.quellDatei || 'ZIP'))
  return true
}

// Gibt es überhaupt etwas zu sichern?
export async function hatAenderungen (id) {
  const stdout = await git(id, ['status', '--porcelain'])
  return stdout.trim().length > 0
}

/**
 * Sichert den aktuellen Stand. Ohne Änderungen passiert nichts.
 * @returns {Promise<{hash:string, dateien:number}|null>}
 */
export async function sichern (id, nachricht) {
  if (!await istRepo(id)) return null
  await git(id, ['add', '-A'])

  const stdout = await git(id, ['status', '--porcelain'])
  const geaendert = stdout.split('\n').filter(z => z.trim()).length
  if (!geaendert) return null

  const wer = await urheber()
  await git(id, [...wer, 'commit', '-q', '-m', nachricht || 'Stand gesichert'])
  const hash = (await git(id, ['rev-parse', 'HEAD'])).trim()
  // Ist ein Fernlager verbunden, geht der neue Stand gleich hoch - bewusst
  // ohne zu warten und ohne Fehler zu werfen (offline ist kein Drama, der
  // naechste Abgleich holt alles nach).
  fernAutoHochladen(id)
  return { hash, dateien: geaendert }
}

// ---------------------------------------------------------------------------
// Verlauf lesen
// ---------------------------------------------------------------------------

export async function verlauf (id, grenze = 300) {
  if (!await istRepo(id)) return []
  let stdout
  try {
    stdout = await git(id, [
      'log', '-n', String(grenze),
      `--pretty=format:${SATZ}%H${FELD}%aI${FELD}%s`,
      '--name-only',
    ])
  } catch {
    return []   // noch kein einziger Stand
  }

  const staende = []
  for (const roh of stdout.split(SATZ)) {
    if (!roh.trim()) continue
    const [kopf, ...rest] = roh.split('\n')
    const [hash, datum, nachricht] = kopf.split(FELD)
    const dateien = rest.map(z => z.trim()).filter(Boolean)
    staende.push({ hash, kurz: hash.slice(0, 7), datum, nachricht, dateien })
  }
  return staende
}

// Was würde sich ändern, wenn ich auf diesen Stand zurückgehe?
export async function vergleichZuJetzt (id, hash) {
  const stat = await git(id, ['diff', '--stat', 'HEAD', hash])
  const patch = await git(id, ['diff', '--unified=3', 'HEAD', hash])
  return { stat: stat.trim(), patch }
}

export async function dateiVergleich (id, hash, rel) {
  const patch = await git(id, ['diff', '--unified=3', 'HEAD', hash, '--', rel])
  return patch
}

// ---------------------------------------------------------------------------
// Zurücksetzen
// ---------------------------------------------------------------------------

/**
 * Setzt das ganze Projekt auf einen früheren Stand.
 * Vorher wird der aktuelle Stand gesichert – es geht also nichts verloren.
 */
export async function zurueckSetzen (id, hash) {
  if (!await istRepo(id)) throw new Error('Für dieses Projekt gibt es keinen Verlauf.')

  // 1. Aktuellen Stand festhalten, damit auch das Zurücksetzen umkehrbar ist.
  const vorher = await sichern(id, 'Automatisch gesichert vor dem Zurücksetzen')

  const info = (await git(id, ['show', '-s', '--format=%aI' + FELD + '%s', hash])).trim()
  const [datum, nachricht] = info.split(FELD)

  // 2. Alten Stand in Arbeitsverzeichnis und Verzeichnis holen.
  await git(id, ['rm', '-r', '--cached', '-q', '.'])
  await git(id, ['checkout', hash, '--', '.'])

  // 3. Alles entfernen, was es damals noch nicht gab. Ausgeschlossene
  //    Ordner (uploads/ und so weiter) bleiben unangetastet – "clean" ohne
  //    -x fasst ignorierte Dateien nicht an.
  await git(id, ['clean', '-fdq'])

  // 4. Als neuen Stand festhalten.
  await git(id, ['add', '-A'])
  const wer = await urheber()
  const stempel = new Date(datum).toLocaleString('de-CH')
  await git(id, [...wer, 'commit', '-q', '--allow-empty',
    '-m', `Zurück auf Stand vom ${stempel} – ${nachricht}`])

  return { zurueckAuf: hash, gesichertVorher: vorher?.hash || null, stempel }
}

/**
 * Holt eine einzelne Datei aus einem früheren Stand zurück.
 */
export async function dateiZurueckSetzen (id, hash, rel) {
  if (!await istRepo(id)) throw new Error('Für dieses Projekt gibt es keinen Verlauf.')
  const vorher = await sichern(id, 'Automatisch gesichert vor dem Zurücksetzen')

  try {
    await git(id, ['checkout', hash, '--', rel])
  } catch {
    throw new Error(`Die Datei ${rel} gab es in diesem Stand noch nicht.`)
  }

  await git(id, ['add', '-A'])
  const wer = await urheber()
  const stempel = (await git(id, ['show', '-s', '--format=%aI', hash])).trim()
  await git(id, [...wer, 'commit', '-q', '--allow-empty',
    '-m', `${rel} zurück auf Stand vom ${new Date(stempel).toLocaleString('de-CH')}`])

  return { datei: rel, gesichertVorher: vorher?.hash || null }
}

// ---------------------------------------------------------------------------
// Fernlager (GitHub) - die Drehscheibe zwischen VinWeb und Mini/Midi
// ---------------------------------------------------------------------------
// Entscheid vom 05.09.2026: Ein privates GitHub-Repo pro Website verbindet
// alle Werkzeuge - gemeinsamer Verlauf inklusive. Laeuft Midi beim Kunden,
// schiebt es seine Staende dorthin; VinWeb holt sie hier ab und kann selbst
// jederzeit fixen und hochladen. FTP/SSH bleibt reiner Deploy-Weg.
//
// Zugang: das GitHub-Token aus ~/.vinweb/keys.json wird NIE in .git/config
// gespeichert, sondern je Aufruf als Kopfzeile mitgegeben - so bleibt die
// Fernlager-Adresse im Repo sauber und das Token in der geschuetzten Datei.

const FERN = 'origin'

function authArgumente (token) {
  if (!token) return []
  const b64 = Buffer.from('x-access-token:' + token).toString('base64')
  return ['-c', `http.https://github.com/.extraheader=Authorization: Basic ${b64}`]
}

async function fernToken () {
  return schluesselHolen('github')
}

// GitHub braucht das Token als Kopfzeile; andere Fernlager (z. B. ein
// selbst gehostetes Git) bringen ihre eigene Anmeldung mit.
async function fernAuth (id) {
  const url = await fernlagerUrl(id)
  if (!url || !/^https:\/\/github\.com\//.test(url)) return []
  const token = await fernToken()
  if (!token) throw new Error('Es fehlt das GitHub-Token - über ⚙ Schlüssel eintragen.')
  return authArgumente(token)
}

export async function fernlagerUrl (id) {
  try {
    return (await git(id, ['remote', 'get-url', FERN])).trim()
  } catch {
    return null
  }
}

export async function fernlagerSetzen (id, url) {
  const sauber = String(url || '').trim().replace(/\/+$/, '')
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?$/.test(sauber)) {
    throw new Error('Bitte eine GitHub-Adresse der Form https://github.com/konto/repo angeben.')
  }
  if (await fernlagerUrl(id)) await git(id, ['remote', 'set-url', FERN, sauber])
  else await git(id, ['remote', 'add', FERN, sauber])
  return sauber
}

export async function fernlagerTrennen (id) {
  try { await git(id, ['remote', 'remove', FERN]) } catch { /* war nicht verbunden */ }
}

// Wie viele Staende liegen nur im Fernlager (eingehend), wie viele nur
// hier (ausgehend)? Rechnet gegen den zuletzt GEHOLTEN Fernstand - ohne Netz.
export async function fernZaehlen (id) {
  // «wartend»: Staende, die die Kunden-Instanz wegen eines Konflikts nicht
  // nach main bringen konnte - sie liegen im Zweig kunde-wartet und
  // brauchen deinen Entscheid.
  let wartend = 0
  try {
    wartend = parseInt(await git(id, ['rev-list', '--count', `HEAD..${FERN}/kunde-wartet`]), 10) || 0
  } catch { /* kein solcher Zweig - der Normalfall */ }
  try {
    const eingehend = parseInt(await git(id, ['rev-list', '--count', `HEAD..${FERN}/main`]), 10) || 0
    const ausgehend = parseInt(await git(id, ['rev-list', '--count', `${FERN}/main..HEAD`]), 10) || 0
    return { eingehend, ausgehend, wartend }
  } catch {
    // Das Fernlager wurde noch nie geholt (oder ist leer) - dann ist alles
    // Lokale "ausgehend". null sagt der Oberflaeche: erst abgleichen.
    return { eingehend: 0, ausgehend: null, wartend }
  }
}

// Holt den Fernstand (nur die Buchhaltung, veraendert keine Dateien).
export async function fernAbgleichen (id) {
  const auth = await fernAuth(id)
  await git(id, [...auth, 'fetch', '-q', FERN, 'main'], { timeout: 30000 })
  // Auch nach festgefahrenen Kundenstaenden sehen - der Zweig existiert
  // nur, wenn die Kunden-Instanz einen Konflikt gemeldet hat.
  try {
    await git(id, [...auth, 'fetch', '-q', FERN, 'kunde-wartet'], { timeout: 30000 })
  } catch {
    // Zweig gibt es nicht (mehr) - dann auch die alte Ortskopie vergessen.
    try { await git(id, ['update-ref', '-d', `refs/remotes/${FERN}/kunde-wartet`]) } catch { /* war keine da */ }
  }
  return fernZaehlen(id)
}

// Laedt die lokalen Staende hoch. Schlaegt fehl, wenn das Fernlager Neues
// hat, das hier noch fehlt - dann zuerst uebernehmen.
export async function fernHochladen (id) {
  const auth = await fernAuth(id)
  try {
    await git(id, [...auth, 'push', '-q', '-u', FERN, 'main'], { timeout: 120000 })
  } catch (e) {
    if (/non-fast-forward|fetch first|rejected/i.test(String(e.stderr || ''))) {
      throw new Error('Das Fernlager hat neue Stände des Kunden - bitte zuerst «Übernehmen».')
    }
    throw new Error('Hochladen fehlgeschlagen: ' + kurzerGitFehler(e))
  }
  return fernZaehlen(id)
}

// Fuehrt den geholten Fernstand mit dem lokalen zusammen.
// strategie: null = normal (Konflikt wird gemeldet, nichts geht verloren),
// 'meine' = bei Konflikten gewinnt die eigene Fassung,
// 'kunde' = bei Konflikten gewinnt die Kundenfassung.
export async function fernUebernehmen (id, strategie) {
  // Offene Aenderungen zuerst festhalten - ein Merge braucht sauberen Boden,
  // und verlieren darf sowieso nie etwas gehen.
  await sichern(id, 'Automatisch gesichert vor dem Übernehmen aus dem Fernlager')

  const wer = await urheber()
  const mergen = async (zweig) => {
    const argumente = [...wer, 'merge', '--no-edit']
    if (strategie === 'meine') argumente.push('-X', 'ours')
    if (strategie === 'kunde') argumente.push('-X', 'theirs')
    argumente.push(`${FERN}/${zweig}`)
    await git(id, argumente)
  }

  const stand = await fernZaehlen(id)
  const reihe = []
  if (stand.eingehend > 0 || stand.ausgehend === null) reihe.push('main')
  if (stand.wartend > 0) reihe.push('kunde-wartet')
  if (!reihe.length) reihe.push('main')   // zur Sicherheit: mindestens main

  for (const zweig of reihe) {
    try {
      await mergen(zweig)
    } catch (e) {
      // Konflikt: die betroffenen Dateien nennen, dann alles zuruecknehmen -
      // der Arbeitsstand bleibt exakt wie vorher, Reto entscheidet per Knopf.
      let dateien = []
      try {
        dateien = (await git(id, ['diff', '--name-only', '--diff-filter=U']))
          .trim().split('\n').filter(Boolean)
      } catch { /* Liste ist Komfort */ }
      try { await git(id, ['merge', '--abort']) } catch { /* kein Merge offen */ }
      if (dateien.length) return { konflikt: true, dateien }
      throw new Error('Übernehmen fehlgeschlagen: ' + kurzerGitFehler(e))
    }
  }

  // Aufgeloeste Kundenstaende: den Wartezweig im Fernlager aufraeumen und
  // das Ergebnis gleich hochladen - so hat der Kunde die Loesung beim
  // naechsten Takt automatisch. Beides bewusst nachsichtig (offline okay).
  try {
    const auth = await fernAuth(id)
    if (stand.wartend > 0) {
      await git(id, [...auth, 'push', '-q', FERN, '--delete', 'kunde-wartet'], { timeout: 30000 })
      try { await git(id, ['update-ref', '-d', `refs/remotes/${FERN}/kunde-wartet`]) } catch { /* weg ist weg */ }
    }
    await git(id, [...auth, 'push', '-q', '-u', FERN, 'main'], { timeout: 120000 })
  } catch { /* der Zaehler unten zeigt, was noch offen ist */ }

  return { ok: true, ...(await fernZaehlen(id)) }
}

// Nach jedem gesicherten Stand still hochladen (von sichern() gerufen).
// Bewusst leise: offline oder ein noch nicht geholter Fernstand sind kein
// Fehler - der naechste manuelle Abgleich zeigt die Lage.
async function fernAutoHochladen (id) {
  try {
    if (!await fernlagerUrl(id)) return
    const stand = await fernZaehlen(id)
    if (stand.eingehend > 0) return   // nie blind ueber Kundenstaende druebergehen
    const auth = await fernAuth(id)
    await git(id, [...auth, 'push', '-q', '-u', FERN, 'main'], { timeout: 120000 })
  } catch { /* still - siehe oben */ }
}

// Die erste Zeile der Git-Fehlermeldung, ohne Token-Reste.
function kurzerGitFehler (e) {
  return String(e.stderr || e.message || '')
    .split('\n').map(z => z.trim()).filter(Boolean)[0] || 'unbekannter Fehler'
}
