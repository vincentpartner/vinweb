// VinWeb - Startpunkt.
//
// Es laufen zwei Server nebeneinander:
//   Port 4400  Bedienoberflaeche und Schnittstelle
//   Port 4401  Vorschau der Kundenwebsite
//
// Die Trennung ist die wichtigste Sicherheitsentscheidung im ganzen Werkzeug:
// Ein Browser behandelt zwei Ports als zwei verschiedene Herkünfte. Damit kann
// ein Skript aus einem fremden ZIP nicht an die Daten der Oberfläche - später
// also auch nicht an deine API-Schlüssel.

import express from 'express'
import path from 'node:path'
import fs from 'node:fs/promises'
import { UI_PORT, PREVIEW_PORT, HOST, ROOT, PROJECTS_DIR, AUTO_SICHERN_SEKUNDEN } from './lib/config.js'
import { projekteAuflisten, projektLesen, projektSchreiben, quellPfad } from './lib/projects.js'
import { zipImportieren, projektLoeschen } from './lib/importer.js'
import { vergleichErstellen, vergleichUebernehmen } from './lib/vergleich.js'
import { projektAnalysieren } from './lib/analyze.js'
import { buildErzeugen, buildPfad } from './lib/build.js'
import { ernten, ERNTE_DIR } from './lib/ernte.js'
import { leeresSeo, leereSeite, ausSiteSett, seoAnwenden, seoZusammenfuehren } from './lib/seo.js'
import { fortschrittBerechnen, SCHRITTE } from './lib/fortschritt.js'
import { endpruefungLaufen } from './lib/endpruefung.js'
import { deployAusfuehren } from './lib/deploy.js'
import { GEHEIM_DATEINAME } from './lib/geheim.js'
import { execFile } from 'node:child_process'
import { schluesselSetzen, schluesselUebersicht, schluesselHolen } from './lib/keys.js'
import { modelleHolen, chatStreamen, fehlerText } from './lib/ai.js'
import { systemAnweisung, antwortZerlegen, vorschlaegePruefen, anwenden, pfadPruefen } from './lib/aenderungen.js'
import {
  repoAnlegen, istRepo, sichern, verlauf, vergleichZuJetzt, dateiVergleich,
  zurueckSetzen, dateiZurueckSetzen, hatAenderungen, gitignoreAnwenden,
  fernlagerUrl, fernlagerSetzen, fernlagerTrennen, fernZaehlen,
  fernAbgleichen, fernHochladen, fernUebernehmen,
} from './lib/git.js'
import { sektionenErnten, bibliothekLesen, bibliothekSchreiben, ETIKETTEN } from './lib/bausteine.js'

// ---------------------------------------------------------------------------
// 1) Oberfläche und Schnittstelle
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Warteschlange je Projekt
// ---------------------------------------------------------------------------
// Alles, was in ein Projekt schreibt (Übernehmen, Sichern, Zurücksetzen,
// automatische Sicherung), läuft nacheinander statt gleichzeitig. Ohne diese
// Schlange könnte die automatische Sicherung mitten in einem Schreibvorgang
// zuschlagen und einen halben Stand festhalten.
const schlangen = new Map()
function nacheinander (id, aufgabe) {
  const vorher = schlangen.get(id) || Promise.resolve()
  const jetzt = vorher.then(aufgabe, aufgabe)
  // Fehler nicht weiterreichen – sonst bliebe die Schlange für immer kaputt.
  schlangen.set(id, jetzt.then(() => {}, () => {}))
  return jetzt
}

const app = express()
app.use(express.json({ limit: '60mb' }))

app.use(express.static(path.join(ROOT, 'ui')))

// Alle Projekte auflisten
app.get('/api/projekte', async (req, res) => {
  try {
    res.json(await projekteAuflisten())
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

// Ein Projekt samt Analyse
app.get('/api/projekte/:id', async (req, res) => {
  const projekt = await projektLesen(req.params.id)
  if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
  // Nur nachsehen, nichts verändern – ein Aufruf zum Lesen darf nichts schreiben.
  projekt.verlaufAktiv = await istRepo(req.params.id)
  projekt.ungesichert = projekt.verlaufAktiv ? await hatAenderungen(req.params.id) : false
  res.json(projekt)
})

// Analyse neu berechnen
app.post('/api/projekte/:id/analyse', async (req, res) => {
  try {
    const projekt = await projektLesen(req.params.id)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
    projekt.analyse = await projektAnalysieren(req.params.id)
    await projektSchreiben(req.params.id, projekt)
    res.json(projekt)
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

// Auswahl speichern: was gehört ins Repo, was auf den Server.
app.put('/api/projekte/:id/auswahl', async (req, res) => {
  try {
    const projekt = await projektLesen(req.params.id)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
    projekt.auswahl = req.body?.auswahl && typeof req.body.auswahl === 'object'
      ? req.body.auswahl
      : {}
    await projektSchreiben(req.params.id, projekt)
    // Die Häkchen bei "Repo" steuern die Ausschlussliste des Verlaufs.
    if (await istRepo(req.params.id)) await gitignoreAnwenden(req.params.id, projekt)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

app.delete('/api/projekte/:id', async (req, res) => {
  try {
    await projektLoeschen(req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

// ZIP hochladen. Der Inhalt kommt roh im Rumpf der Anfrage, der Dateiname
// im Kopfzeilenfeld - so brauchen wir keinen zusätzlichen Formular-Zerleger.
app.post('/api/import',
  express.raw({ type: 'application/octet-stream', limit: '500mb' }),
  async (req, res) => {
    try {
      const dateiname = decodeURIComponent(req.get('x-dateiname') || 'Projekt.zip')
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ fehler: 'Keine Daten empfangen.' })
      }
      const ergebnis = await zipImportieren(req.body, dateiname)
      const projekt = await projektLesen(ergebnis.id)
      projekt.analyse = await projektAnalysieren(ergebnis.id)
      await projektSchreiben(ergebnis.id, projekt)
      await repoAnlegen(ergebnis.id, projekt).catch(() => {})
      res.json(projekt)
    } catch (e) {
      res.status(400).json({ fehler: e.message })
    }
  })

// Import direkt von einem Pfad auf diesem Mac - bei grossen ZIPs deutlich
// schneller als der Umweg durch den Browser.
app.post('/api/import-pfad', async (req, res) => {
  try {
    const roh = String(req.body?.pfad || '').trim().replace(/^['"]|['"]$/g, '')
    if (!roh) return res.status(400).json({ fehler: 'Kein Pfad angegeben.' })
    const pfad = roh.startsWith('~') ? path.join(process.env.HOME || '', roh.slice(1)) : roh
    if (!/\.zip$/i.test(pfad)) return res.status(400).json({ fehler: 'Das ist keine ZIP-Datei.' })

    const puffer = await fs.readFile(pfad)
    const ergebnis = await zipImportieren(puffer, path.basename(pfad))
    const projekt = await projektLesen(ergebnis.id)
    projekt.analyse = await projektAnalysieren(ergebnis.id)
    await projektSchreiben(ergebnis.id, projekt)
    await repoAnlegen(ergebnis.id, projekt).catch(() => {})
    res.json(projekt)
  } catch (e) {
    const text = e.code === 'ENOENT' ? 'Datei nicht gefunden.' : e.message
    res.status(400).json({ fehler: text })
  }
})

// ---------------------------------------------------------------------------
// KI: Schlüssel, Modelle, Chat
// ---------------------------------------------------------------------------

app.get('/api/schluessel', async (req, res) => {
  res.json(await schluesselUebersicht())
})

app.put('/api/schluessel', async (req, res) => {
  try {
    await schluesselSetzen(req.body?.anbieter, req.body?.schluessel)
    res.json(await schluesselUebersicht())
  } catch (e) {
    res.status(400).json({ fehler: e.message })
  }
})

app.get('/api/modelle/:anbieter', async (req, res) => {
  try {
    res.json(await modelleHolen(req.params.anbieter))
  } catch (e) {
    res.status(400).json({ fehler: fehlerText(e) })
  }
})

// Alle Textdateien des Projekts – für die Kontext-Auswahl im Chat.
// Dateien mit Zugangsdaten werden gar nicht erst angeboten.
const GEHEIM_NAME = GEHEIM_DATEINAME   // zentral in lib/geheim.js

app.get('/api/projekte/:id/textdateien', async (req, res) => {
  try {
    const wurzel = quellPfad(req.params.id)
    const raus = []
    async function ab (ordner, rel) {
      for (const e of await fs.readdir(ordner, { withFileTypes: true })) {
        if (e.name === '.git') continue
        const relNeu = rel ? rel + '/' + e.name : e.name
        // Arbeitsordner auslassen – deren Inhalt gehört nicht in den KI-Kontext.
        if (e.isDirectory()) {
          if (['uploads', 'scraps', 'export', 'mobile', 'versionen'].includes(e.name)) continue
          await ab(path.join(ordner, e.name), relNeu)
        } else if (/\.(html?|css|js|json|md|xml|txt|php)$/i.test(e.name)) {
          if (GEHEIM_NAME.test(relNeu)) continue
          raus.push(relNeu)
        }
      }
    }
    await ab(wurzel, '')
    raus.sort()
    res.json(raus)
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

// Stellt den Zusammenhang zusammen, den die KI braucht.
async function kontextBauen (projekt, seiten) {
  const wurzel = quellPfad(projekt.id)
  const teile = []
  let bytes = 0
  const GRENZE = 400 * 1024

  for (const rel of seiten || []) {
    const ziel = pfadPruefen(wurzel, rel)
    if (!ziel) continue
    if (GEHEIM_NAME.test(ziel.rel)) continue   // Zugangsdaten nie zur KI
    try {
      const inhalt = await fs.readFile(ziel.voll, 'utf8')
      if (bytes + inhalt.length > GRENZE) {
        teile.push(`--- ${ziel.rel} --- (zu gross, ausgelassen)`)
        continue
      }
      bytes += inhalt.length
      teile.push(`--- AKTUELLER INHALT VON ${ziel.rel} ---\n${inhalt}`)
    } catch { /* Datei nicht lesbar */ }
  }
  return teile.join('\n\n')
}

app.post('/api/chat', async (req, res) => {
  const { projektId, anbieter, modell, verlauf = [], frage = '',
    anhaenge = [], kontextSeiten = [] } = req.body || {}

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  const senden = (art, daten) => res.write(`event: ${art}\ndata: ${JSON.stringify(daten)}\n\n`)

  // Bricht der Browser ab (Stopp-Knopf, Seite geschlossen), kappen wir sofort
  // auch die Verbindung zum KI-Anbieter – ab da entstehen keine Kosten mehr.
  // Wichtig: auf das Schliessen der ANTWORT horchen, nicht der Anfrage –
  // req 'close' feuert schon, sobald die Anfrage fertig gelesen ist.
  const abbruch = new AbortController()
  res.on('close', () => { if (!res.writableEnded) abbruch.abort() })

  try {
    const projekt = await projektLesen(projektId)
    if (!projekt) throw new Error('Projekt nicht gefunden.')

    const dateiliste = (projekt.analyse?.struktur || [])
      .filter(s => s.server)
      .map(s => '  ' + s.name + (s.istOrdner ? '/' : ''))
      .join('\n')
    const befunde = (projekt.analyse?.befunde || [])
      .map(b => `  [${b.stufe}] ${b.titel}`)
      .join('\n')

    const system = systemAnweisung({ dateiliste, befunde })

    // Text-Anhänge kommen als Text mit, Bilder als Bild.
    const bilder = []
    const textAnhaenge = []
    for (const a of anhaenge) {
      if (!a?.base64) continue
      if (/^image\//.test(a.mediaType) && a.mediaType !== 'image/svg+xml') {
        bilder.push({ mediaType: a.mediaType, base64: a.base64 })
      } else {
        const roh = Buffer.from(a.base64, 'base64').toString('utf8').slice(0, 120000)
        textAnhaenge.push(`--- ANGEHÄNGTE DATEI ${a.name} ---\n${roh}`)
      }
    }

    const kontext = await kontextBauen(projekt, kontextSeiten)
    const hinweisBilder = bilder.length
      ? `\n\nEs sind ${bilder.length} Bild(er) angehängt. Beim Übernehmen werden sie unter `
        + `assets/upload/<Dateiname> abgelegt – verweise im HTML auf genau diesen Pfad.`
      : ''

    // Nur die letzten Runden mitschicken – ein endlos wachsender Verlauf macht
    // jede Anfrage langsamer und teurer, ohne der KI wirklich zu helfen. Das
    // Wissen über die Dateien trägt der KONTEXT unten, und der ist immer aktuell.
    const VERLAUF_MAX = 8
    const nachrichten = [
      ...(verlauf || []).slice(-VERLAUF_MAX).map(n => ({ rolle: n.rolle, text: n.text })),
      {
        rolle: 'user',
        bilder,
        text: [kontext, ...textAnhaenge, '--- AUFGABE ---', frage + hinweisBilder]
          .filter(Boolean).join('\n\n'),
      },
    ]

    // Verbrauch höchstens zweimal pro Sekunde weiterreichen – reicht fürs Auge.
    let letzterPuls = 0

    // Automatisches Nachreichen: Fordert die KI Dateien an (VINWEB-BRAUCHE-Zeile),
    // prüft VinWeb die Pfade, liefert die Inhalte nach und lässt sie die Aufgabe
    // im selben Durchgang fertig lösen. Höchstens eine Nachlieferungs-Runde –
    // sonst könnte eine verwirrte KI endlos Dateien anfordern und Kosten anhäufen.
    const BRAUCHE = /===\s*VINWEB-BRAUCHE:\s*([^=]+?)\s*===/i
    const wurzelChat = quellPfad(projektId)
    let aktuelleNachrichten = nachrichten
    let text = ''
    const verbrauchSumme = { ein: 0, aus: 0 }
    let verbrauchDa = false

    for (let runde = 1; runde <= 2; runde++) {
      const r = await chatStreamen({
        anbieter, modell, system,
        nachrichten: aktuelleNachrichten,
        signal: abbruch.signal,
        onText: (t) => senden('text', { t }),
        onVerbrauch: (v) => {
          const jetzt = Date.now()
          if (jetzt - letzterPuls > 500 || !v.geschaetzt) {
            letzterPuls = jetzt
            senden('verbrauch', {
              ...v,
              ein: (v.ein || 0) + verbrauchSumme.ein,
              aus: (v.aus || 0) + verbrauchSumme.aus,
            })
          }
        },
      })
      text = r.text
      if (r.verbrauch?.ein != null) {
        verbrauchSumme.ein += r.verbrauch.ein
        verbrauchSumme.aus += r.verbrauch.aus || 0
        verbrauchDa = true
      }

      const m = text.match(BRAUCHE)
      if (!m || runde === 2) break

      const gewuenscht = m[1].split(',').map(t => t.trim()).filter(Boolean).slice(0, 6)
      const geliefert = []
      const verweigert = []
      const teile = []
      for (const rel of gewuenscht) {
        const ziel = pfadPruefen(wurzelChat, rel)
        if (!ziel || GEHEIM_NAME.test(ziel.rel)) { verweigert.push(rel); continue }
        try {
          const inhalt = await fs.readFile(ziel.voll, 'utf8')
          if (inhalt.length > 300 * 1024) { verweigert.push(rel + ' (zu gross)'); continue }
          teile.push(`--- AKTUELLER INHALT VON ${ziel.rel} ---\n${inhalt}`)
          geliefert.push(ziel.rel)
        } catch { verweigert.push(rel + ' (nicht gefunden)') }
      }
      if (!geliefert.length) {
        // Angefordert, aber nichts lieferbar – das dem Nutzer klar sagen,
        // statt die Antwort einfach abbrechen zu lassen.
        const hinweis = `\n\n［VinWeb: ${verweigert.join(', ')} wird nicht übergeben – `
          + 'Zugangsdaten bleiben immer aussen vor, Übriges wurde nicht gefunden.］'
        senden('text', { t: hinweis })
        text += hinweis
        break
      }

      senden('kontextErweitert', { dateien: geliefert, verweigert })
      senden('text', { t: `\n\n［VinWeb reicht automatisch nach: ${geliefert.join(', ')}］\n\n` })

      aktuelleNachrichten = [
        ...aktuelleNachrichten,
        { rolle: 'assistant', text },
        {
          rolle: 'user',
          text: teile.join('\n\n')
            + (verweigert.length ? `\n\nNicht verfügbar: ${verweigert.join(', ')}` : '')
            + '\n\nDamit hast du alles – bitte führe die ursprüngliche Aufgabe jetzt aus.',
        },
      ]
    }

    const verbrauch = verbrauchDa ? verbrauchSumme : null
    // Eine übrig gebliebene Anforderungs-Zeile gehört nicht in die Anzeige.
    const zerlegt = antwortZerlegen(text.replace(BRAUCHE, '').trim())
    const aenderungen = zerlegt.dateien.length
      ? await vorschlaegePruefen(projektId, zerlegt.dateien)
      : []

    senden('fertig', { text: zerlegt.text, aenderungen, verbrauch })
  } catch (e) {
    if (abbruch.signal.aborted) {
      // Vom Nutzer gestoppt – kein Fehler, nur Schweigen.
    } else {
      senden('fehler', { text: fehlerText(e) })
    }
  } finally {
    res.end()
  }
})

// Freigegebene Änderungen schreiben – durch die Warteschlange des Projekts.
app.post('/api/anwenden', (req, res) => {
  const { projektId, dateien = [], notiz = '' } = req.body || {}
  return nacheinander(String(projektId || ''), async () => {
  try {
    const projekt = await projektLesen(projektId)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
    if (!dateien.length) return res.status(400).json({ fehler: 'Nichts zum Übernehmen.' })

    const mitRepo = await istRepo(projektId)
    // Erst alles festhalten, was sich seit dem letzten Mal von aussen geändert
    // hat – sonst ginge Arbeit ausserhalb von VinWeb beim Zurücksetzen verloren.
    if (mitRepo) await sichern(projektId, 'Änderungen von aussen')

    const ergebnis = await anwenden(projektId, dateien, notiz, !mitRepo)
    if (!ergebnis.geschrieben.length) {
      return res.status(400).json({
        fehler: 'Keine Datei geschrieben – alle Pfade lagen ausserhalb des Projekts.',
      })
    }
    if (mitRepo) {
      const stand = await sichern(projektId, notiz || 'Änderung übernommen')
      ergebnis.stand = stand?.hash?.slice(0, 7) || null
    }
    projekt.analyse = await projektAnalysieren(projektId)
    projekt.letzteAenderung = new Date().toISOString()
    await projektSchreiben(projektId, projekt)
    projekt.verlaufAktiv = mitRepo
    projekt.ungesichert = false
    res.json({ ...ergebnis, projekt })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
  })
})

// ---------------------------------------------------------------------------
// Verlauf: sichern, ansehen, zurücksetzen
// ---------------------------------------------------------------------------

// Ein paar Eckdaten für die Oberfläche (z. B. Sicherungstakt anzeigen).
app.get('/api/info', (req, res) => {
  res.json({
    autoSichernSekunden: AUTO_SICHERN_SEKUNDEN,
  })
})

app.get('/api/projekte/:id/verlauf', async (req, res) => {
  try {
    res.json(await verlauf(req.params.id))
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

// Knopf "Stand jetzt sichern" – durch die Warteschlange des Projekts.
app.post('/api/projekte/:id/sichern', (req, res) => nacheinander(req.params.id, async () => {
  try {
    const projekt = await projektLesen(req.params.id)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
    if (!await istRepo(req.params.id)) await repoAnlegen(req.params.id, projekt)

    const name = String(req.body?.nachricht || '').trim()
    const stand = await sichern(req.params.id, name || 'Stand gesichert')
    res.json({ stand, nichtsZuTun: !stand })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
}))

// Was würde sich beim Zurücksetzen ändern?
app.get('/api/projekte/:id/verlauf/:hash/vergleich', async (req, res) => {
  try {
    const datei = req.query.datei
    if (datei) {
      res.json({ patch: await dateiVergleich(req.params.id, req.params.hash, String(datei)) })
    } else {
      res.json(await vergleichZuJetzt(req.params.id, req.params.hash))
    }
  } catch (e) {
    res.status(400).json({ fehler: e.message })
  }
})

// Ganzes Projekt zurücksetzen – durch die Warteschlange des Projekts.
app.post('/api/projekte/:id/zurueck', (req, res) => nacheinander(req.params.id, async () => {
  try {
    const hash = String(req.body?.hash || '')
    if (!/^[0-9a-f]{7,40}$/.test(hash)) return res.status(400).json({ fehler: 'Ungültiger Stand.' })

    const ergebnis = await zurueckSetzen(req.params.id, hash)
    const projekt = await projektLesen(req.params.id)
    projekt.analyse = await projektAnalysieren(req.params.id)
    await projektSchreiben(req.params.id, projekt)
    projekt.verlaufAktiv = true
    projekt.ungesichert = false
    res.json({ ...ergebnis, projekt })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
}))

// Einzelne Datei zurücksetzen – durch die Warteschlange des Projekts.
app.post('/api/projekte/:id/zurueck-datei', (req, res) => nacheinander(req.params.id, async () => {
  try {
    const hash = String(req.body?.hash || '')
    const datei = String(req.body?.datei || '')
    if (!/^[0-9a-f]{7,40}$/.test(hash)) return res.status(400).json({ fehler: 'Ungültiger Stand.' })
    if (!datei) return res.status(400).json({ fehler: 'Keine Datei angegeben.' })

    const ergebnis = await dateiZurueckSetzen(req.params.id, hash, datei)
    const projekt = await projektLesen(req.params.id)
    projekt.analyse = await projektAnalysieren(req.params.id)
    await projektSchreiben(req.params.id, projekt)
    projekt.verlaufAktiv = true
    projekt.ungesichert = false
    res.json({ ...ergebnis, projekt })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
}))

// ---------------------------------------------------------------------------
// Inhalte ernten (Texte und Bilder einer bestehenden Website)
// ---------------------------------------------------------------------------

let ernteLaeuft = false

// ---------------------------------------------------------------------------
// Fernlager (GitHub) - Sync zwischen VinWeb und Mini/Midi
// ---------------------------------------------------------------------------

// Zustand fuer die Oberflaeche - ohne Netz (rechnet gegen den zuletzt
// geholten Fernstand). Abgleichen unten holt frisch.
app.get('/api/projekte/:id/fernlager', async (req, res) => {
  try {
    const url = await fernlagerUrl(req.params.id)
    const tokenDa = Boolean(await schluesselHolen('github'))
    if (!url) return res.json({ url: null, tokenDa })
    res.json({ url, tokenDa, ...(await fernZaehlen(req.params.id)) })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

// Verbinden: Adresse merken und den lokalen Stand gleich hochladen.
app.post('/api/projekte/:id/fernlager', (req, res) => nacheinander(req.params.id, async () => {
  try {
    if (!await istRepo(req.params.id)) {
      return res.status(400).json({ fehler: 'Dieses Projekt hat noch keinen Verlauf.' })
    }
    const url = await fernlagerSetzen(req.params.id, req.body?.url)
    const stand = await fernHochladen(req.params.id)
    res.json({ ok: true, url, ...stand })
  } catch (e) {
    // Nicht halb verbunden stehen lassen, wenn schon das Hochladen scheitert.
    res.status(400).json({ fehler: e.message })
  }
}))

app.delete('/api/projekte/:id/fernlager', (req, res) => nacheinander(req.params.id, async () => {
  await fernlagerTrennen(req.params.id)
  res.json({ ok: true })
}))

// Frisch nachsehen: Was liegt im Fernlager, was nur hier?
app.post('/api/projekte/:id/fernlager/abgleichen', async (req, res) => {
  try {
    res.json(await fernAbgleichen(req.params.id))
  } catch (e) {
    res.status(400).json({ fehler: e.message })
  }
})

// Kundenstaende uebernehmen. strategie: leer = normal (Konflikt wird
// gemeldet), 'meine'/'kunde' = wer bei Konflikten gewinnt.
app.post('/api/projekte/:id/fernlager/uebernehmen', (req, res) => nacheinander(req.params.id, async () => {
  try {
    const ergebnis = await fernUebernehmen(req.params.id, req.body?.strategie || null)
    if (ergebnis.konflikt) return res.json(ergebnis)
    // Der Stand hat sich geaendert - Analyse nachfuehren, damit Seitenliste
    // und Befunde zum neuen Inhalt passen.
    const projekt = await projektLesen(req.params.id)
    if (projekt) {
      projekt.analyse = await projektAnalysieren(req.params.id)
      await projektSchreiben(req.params.id, projekt)
    }
    res.json(ergebnis)
  } catch (e) {
    res.status(400).json({ fehler: e.message })
  }
}))

app.post('/api/projekte/:id/fernlager/hochladen', (req, res) => nacheinander(req.params.id, async () => {
  try {
    res.json({ ok: true, ...(await fernHochladen(req.params.id)) })
  } catch (e) {
    res.status(400).json({ fehler: e.message })
  }
}))

app.post('/api/ernte', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  const senden = (art, daten) => res.write(`event: ${art}\ndata: ${JSON.stringify(daten)}\n\n`)

  if (ernteLaeuft) {
    senden('fehler', { text: 'Es läuft bereits eine Ernte – bitte warten.' })
    return res.end()
  }
  ernteLaeuft = true
  // Stopp-Knopf: bricht der Browser die Anfrage ab, hört die Ernte auf
  // (und schliesst sauber mit dem bisher Gesammelten ab).
  const abbruch = new AbortController()
  // res.close (nicht req.close): feuert erst, wenn die VERBINDUNG wirklich weg
  // ist – req.close kann schon nach dem Einlesen des Bodys feuern und würde
  // die Ernte fälschlich sofort stoppen.
  res.on('close', () => { if (!res.writableEnded) abbruch.abort() })
  try {
    const bericht = await ernten({
      url: String(req.body?.url || ''),
      maxSeiten: Math.min(Number(req.body?.maxSeiten) || 60, 150),
      nurSeite: Boolean(req.body?.nurSeite),
      signal: abbruch.signal,
      onMeldung: (text) => senden('meldung', { text }),
    })
    senden('fertig', bericht)
  } catch (e) {
    senden('fehler', { text: e.message })
  } finally {
    ernteLaeuft = false
    res.end()
  }
})

// Alle bisherigen Ernten auflisten (für die Verwaltungs-Ansicht).
app.get('/api/ernten', async (req, res) => {
  try {
    let eintraege = []
    try {
      eintraege = await fs.readdir(ERNTE_DIR, { withFileTypes: true })
    } catch { return res.json([]) }
    const raus = []
    for (const e of eintraege) {
      if (!e.isDirectory()) continue
      try {
        const b = JSON.parse(await fs.readFile(path.join(ERNTE_DIR, e.name, 'bericht.json'), 'utf8'))
        raus.push({
          name: e.name,
          url: b.url || ('https://' + (b.host || e.name)),
          erstelltAm: b.erstelltAm || null,
          seiten: b.seiten ?? null,
          bilder: b.bilder ?? null,
          nurSeite: Boolean(b.nurSeite),
          gestoppt: Boolean(b.gestoppt),
          ordner: path.join(ERNTE_DIR, e.name),
        })
      } catch {
        raus.push({ name: e.name, url: e.name, erstelltAm: null, ordner: path.join(ERNTE_DIR, e.name) })
      }
    }
    raus.sort((a, b) => String(b.erstelltAm || '').localeCompare(String(a.erstelltAm || '')))
    res.json(raus)
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

// Eine Ernte endgültig löschen. Nur direkte Unterordner von ernte/.
app.delete('/api/ernten/:name', async (req, res) => {
  try {
    const name = path.basename(String(req.params.name))
    const ordner = path.join(ERNTE_DIR, name)
    if (!path.resolve(ordner).startsWith(path.resolve(ERNTE_DIR) + path.sep)) {
      return res.status(400).json({ fehler: 'Ungültiger Ordner.' })
    }
    await fs.rm(ordner, { recursive: true, force: true })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

// Den Ernte-Ordner im Finder öffnen. Nur Ordner innerhalb von ernte/ erlaubt.
app.post('/api/ernte/oeffnen', (req, res) => {
  const ordner = path.resolve(String(req.body?.ordner || ''))
  if (!ordner.startsWith(path.resolve(ERNTE_DIR) + path.sep)) {
    return res.status(400).json({ fehler: 'Ungültiger Ordner.' })
  }
  execFile('open', [ordner], (e) => {
    if (e) return res.status(500).json({ fehler: e.message })
    res.json({ ok: true })
  })
})

// Eine Seite löschen – durch die Warteschlange, mit Sicherung davor.
// Der Verlauf behält den letzten Stand der Datei; nichts ist unwiederbringlich.
app.delete('/api/projekte/:id/seiten', (req, res) => nacheinander(req.params.id, async () => {
  try {
    const projekt = await projektLesen(req.params.id)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })

    const rel = String(req.query.rel || '')
    const wurzel = quellPfad(req.params.id)
    const ziel = pfadPruefen(wurzel, rel)
    if (!ziel || !/\.html?$/i.test(ziel.rel)) {
      return res.status(400).json({ fehler: 'Nur HTML-Seiten lassen sich hier löschen.' })
    }
    try { await fs.access(ziel.voll) } catch {
      return res.status(404).json({ fehler: 'Diese Seite gibt es nicht (mehr).' })
    }

    // Erst den Ist-Zustand festhalten, dann löschen, dann den Löschstand sichern –
    // so lässt sich beides im Verlauf gezielt ansteuern.
    const mitRepo = await istRepo(req.params.id)
    if (mitRepo) await sichern(req.params.id, 'Änderungen von aussen')
    await fs.rm(ziel.voll)
    if (mitRepo) await sichern(req.params.id, 'Seite gelöscht: ' + ziel.rel)

    // Auch aus der SEO-Tabelle nehmen, sonst geistert sie dort weiter.
    if (projekt.seo?.pages) delete projekt.seo.pages[ziel.rel]
    projekt.analyse = await projektAnalysieren(req.params.id)
    await projektSchreiben(req.params.id, projekt)
    res.json({ ok: true, geloescht: ziel.rel })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
}))

// ---------------------------------------------------------------------------
// ZIP-Download: aktueller Quellstand als Archiv
// ---------------------------------------------------------------------------
// Für den Rundgang über SiteSett: Stand herunterladen, dort die SEO-Detail-
// arbeit machen, und NUR die Config wieder importieren. Der Verlauf (.git)
// und die Sicherungsordner bleiben aussen vor.

app.get('/api/projekte/:id/zip', async (req, res) => {
  try {
    const projekt = await projektLesen(req.params.id)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })

    const AdmZip = (await import('adm-zip')).default
    const zip = new AdmZip()
    const wurzel = quellPfad(req.params.id)
    async function sammeln (ordner, rel) {
      for (const e of await fs.readdir(ordner, { withFileTypes: true })) {
        if (e.name === '.git') continue
        const voll = path.join(ordner, e.name)
        const relNeu = rel ? rel + '/' + e.name : e.name
        if (e.isDirectory()) await sammeln(voll, relNeu)
        else zip.addFile(relNeu, await fs.readFile(voll))
      }
    }
    await sammeln(wurzel, '')
    const name = projekt.id + '-' + new Date().toISOString().slice(0, 10) + '.zip'
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"')
    res.send(zip.toBuffer())
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

// ---------------------------------------------------------------------------
// Fortschritt: der Weg zum Go-Live
// ---------------------------------------------------------------------------

app.get('/api/projekte/:id/fortschritt', async (req, res) => {
  try {
    const projekt = await projektLesen(req.params.id)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
    res.json(await fortschrittBerechnen(projekt))
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

// Einen manuellen Schritt abhaken oder den Haken zurücknehmen.
app.put('/api/projekte/:id/fortschritt', async (req, res) => {
  try {
    const projekt = await projektLesen(req.params.id)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
    const { schritt, fertig } = req.body || {}
    const def = SCHRITTE.find(s => s.id === schritt)
    if (!def) return res.status(400).json({ fehler: 'Unbekannter Schritt.' })
    if (def.art === 'auto') {
      return res.status(400).json({ fehler: 'Diesen Schritt misst VinWeb selbst – er lässt sich nicht von Hand setzen.' })
    }
    if (def.id === 'golive') {
      return res.status(400).json({ fehler: 'Der Go-Live-Haken kommt mit dem Deploy (Etappe 6).' })
    }
    projekt.fortschritt = projekt.fortschritt || {}
    projekt.fortschritt[schritt] = Boolean(fertig)
    await projektSchreiben(req.params.id, projekt)
    res.json(await fortschrittBerechnen(projekt))
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

// ---------------------------------------------------------------------------
// Deploy: Build auf den Server stellen (vorerst nur Staging)
// ---------------------------------------------------------------------------

app.post('/api/projekte/:id/deploy/staging', (req, res) => nacheinander('deploy:' + req.params.id, async () => {
  try {
    const projekt = await projektLesen(req.params.id)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
    const meldungen = []
    // Immer frisch bauen - damit kann NIE ein alter Stand hochgehen, und der
    // Merksatz «erst Build, dann Staging» entfaellt ersatzlos.
    meldungen.push('Erzeuge frischen Build …')
    const buildBericht = await buildErzeugen(projekt)
    if (projekt.seo) buildBericht.seo = await seoAnwenden(projekt.seo, buildPfad(req.params.id))
    projekt.letzterBuild = buildBericht.erstelltAm
    const ergebnis = await deployAusfuehren(projekt, 'staging', (t) => meldungen.push(t))
    projekt.letzterStagingDeploy = ergebnis.am
    await projektSchreiben(req.params.id, projekt)
    res.json({ ...ergebnis, meldungen })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
}))

// ---------------------------------------------------------------------------
// KI-Endprüfung vor dem Go-Live
// ---------------------------------------------------------------------------

app.get('/api/projekte/:id/endpruefung', async (req, res) => {
  const projekt = await projektLesen(req.params.id)
  if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
  res.json(projekt.kiPruefung || null)
})

app.post('/api/projekte/:id/endpruefung', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  })
  const senden = (art, daten) => res.write(`event: ${art}\ndata: ${JSON.stringify(daten)}\n\n`)
  try {
    const projekt = await projektLesen(req.params.id)
    if (!projekt) throw new Error('Projekt nicht gefunden.')
    const { anbieter, modell } = req.body || {}
    if (!anbieter || !modell) throw new Error('Bitte zuerst Anbieter und Modell wählen (rechts in der KI-Spalte).')

    const bericht = await nacheinander('pruefung:' + req.params.id, () =>
      endpruefungLaufen({ projekt, anbieter, modell, onMeldung: (t) => senden('meldung', { t }) }))

    projekt.kiPruefung = bericht
    await projektSchreiben(req.params.id, projekt)
    senden('fertig', bericht)
  } catch (e) {
    senden('fehler', { text: fehlerText(e) })
  } finally {
    res.end()
  }
})

// ---------------------------------------------------------------------------
// Design-Update: frisches ZIP gegen das Projekt vergleichen und gezielt übernehmen
// ---------------------------------------------------------------------------

// Vergleich per Browser-Upload (Dateiwähler / Hineinziehen) – der Browser
// kennt keine Mac-Pfade, also kommt das ZIP als Rohdaten.
app.post('/api/projekte/:id/vergleich-upload',
  express.raw({ type: 'application/octet-stream', limit: '500mb' }),
  async (req, res) => {
    try {
      const projekt = await projektLesen(req.params.id)
      if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ fehler: 'Keine Daten empfangen.' })
      }
      const name = decodeURIComponent(req.get('x-dateiname') || 'Upload.zip')
      res.json(await vergleichErstellen(req.params.id, req.body, name))
    } catch (e) {
      res.status(400).json({ fehler: e.message })
    }
  })

app.post('/api/projekte/:id/vergleich', async (req, res) => {
  try {
    const projekt = await projektLesen(req.params.id)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
    const roh = String(req.body?.pfad || '').trim().replace(/^['"]|['"]$/g, '')
    const pfad = roh.startsWith('~') ? path.join(process.env.HOME || '', roh.slice(1)) : roh
    if (!/\.zip$/i.test(pfad)) return res.status(400).json({ fehler: 'Das ist keine ZIP-Datei.' })
    res.json(await vergleichErstellen(req.params.id, pfad))
  } catch (e) {
    res.status(400).json({ fehler: e.code === 'ENOENT' ? 'Datei nicht gefunden.' : e.message })
  }
})

app.post('/api/projekte/:id/vergleich/uebernehmen', (req, res) => nacheinander(req.params.id, async () => {
  try {
    const projekt = await projektLesen(req.params.id)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
    const gewaehlt = Array.isArray(req.body?.dateien) ? req.body.dateien : []
    if (!gewaehlt.length) return res.status(400).json({ fehler: 'Nichts ausgewählt.' })

    // Erst festhalten, was von aussen offen ist – dann übernehmen, dann sichern.
    if (await istRepo(req.params.id)) await sichern(req.params.id, 'Änderungen von aussen')
    const ergebnis = await vergleichUebernehmen(req.params.id, gewaehlt)
    if (await istRepo(req.params.id)) {
      await sichern(req.params.id,
        `Design-Update aus ${ergebnis.zip}: ${ergebnis.uebernommen.length} Datei(en) übernommen`)
    }
    projekt.analyse = await projektAnalysieren(req.params.id)
    projekt.letzteAenderung = new Date().toISOString()
    await projektSchreiben(req.params.id, projekt)
    res.json({ ...ergebnis, projekt })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
}))

// ---------------------------------------------------------------------------
// SEO: Site-Profil, Seiten-Metadaten, Weiterleitungen
// ---------------------------------------------------------------------------

// Für jede Seite der Analyse einen SEO-Eintrag anbieten – vorhandene bleiben.
function seoSeitenAbgleichen (projekt, seo) {
  for (const seite of projekt.analyse?.seiten || []) {
    if (!seite.rel.includes('/') && !seo.pages[seite.rel]) {
      seo.pages[seite.rel] = { ...leereSeite(), titel: seite.titel || '' }
    }
  }
  return seo
}

app.get('/api/projekte/:id/seo', async (req, res) => {
  const projekt = await projektLesen(req.params.id)
  if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
  res.json(seoSeitenAbgleichen(projekt, projekt.seo || leeresSeo()))
})

app.put('/api/projekte/:id/seo', async (req, res) => {
  try {
    const projekt = await projektLesen(req.params.id)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
    const seo = req.body?.seo
    if (!seo || typeof seo !== 'object') return res.status(400).json({ fehler: 'Keine SEO-Daten.' })
    delete seo.apiKey; if (seo.ai) delete seo.ai   // Schlüssel haben hier nichts verloren
    projekt.seo = seo
    await projektSchreiben(req.params.id, projekt)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

// Bestehende sitesett-config.json übernehmen (API-Schlüssel wird verworfen).
app.post('/api/projekte/:id/seo/import-sitesett', async (req, res) => {
  try {
    const projekt = await projektLesen(req.params.id)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
    const roh = String(req.body?.pfad || '').trim().replace(/^['"]|['"]$/g, '')
    const pfad = roh.startsWith('~') ? path.join(process.env.HOME || '', roh.slice(1)) : roh
    if (!/\.json$/i.test(pfad)) return res.status(400).json({ fehler: 'Das ist keine JSON-Datei.' })
    const daten = JSON.parse(await fs.readFile(pfad, 'utf8'))
    const { seo, dateien } = ausSiteSett(daten)
    // Zusammenführen statt überschreiben: Handarbeit aus dem SEO-Reiter und
    // Seiten, die SiteSett nicht kennt, bleiben erhalten.
    const { seo: vereint, geschuetzt } = seoZusammenfuehren(projekt.seo, seo)
    projekt.seo = vereint

    // Bilder aus der Config (OG-Bilder, Favicon) als echte Dateien in die
    // Quelle legen – das sind Inhalte, keine Metadaten. Sie gehören ins
    // Projekt, damit alle Verweise darauf funktionieren.
    const wurzelSeo = quellPfad(req.params.id)
    let bilder = 0
    for (const d of dateien) {
      const ziel = pfadPruefen(wurzelSeo, d.pfad)
      if (!ziel) continue
      await fs.mkdir(path.dirname(ziel.voll), { recursive: true })
      await fs.writeFile(ziel.voll, d.puffer)
      bilder++
    }
    if (bilder && await istRepo(req.params.id)) {
      await nacheinander(req.params.id, () =>
        sichern(req.params.id, `SiteSett-Import: ${bilder} Bild(er) übernommen`))
    }
    if (bilder) projekt.analyse = await projektAnalysieren(req.params.id)

    await projektSchreiben(req.params.id, projekt)
    res.json({
      seo: projekt.seo,
      uebernommen: {
        seiten: Object.keys(projekt.seo.pages).length,
        redirects: projekt.seo.redirects.length,
        bilder,
        favicon: projekt.seo.site.faviconDatei || null,
        mitFaq: Object.values(projekt.seo.pages).filter(x => x.faqs?.length).length,
        geschuetzteSeiten: geschuetzt.seiten,
        geschuetzteFelder: geschuetzt.felder,
        schluesselVerworfen: Boolean(daten.ai?.apiKey),
      },
    })
  } catch (e) {
    res.status(400).json({ fehler: e.code === 'ENOENT' ? 'Datei nicht gefunden.' : e.message })
  }
})

// Fehlende Titel und Beschreibungen von der KI vorschlagen lassen.
// Die Vorschläge landen NUR in der SEO-Tabelle – geschrieben wird erst beim Build,
// und in der Tabelle kannst du vorher alles ändern.
app.post('/api/projekte/:id/seo/ki-fuellen', async (req, res) => {
  try {
    const { anbieter, modell } = req.body || {}
    const projekt = await projektLesen(req.params.id)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
    const seo = seoSeitenAbgleichen(projekt, projekt.seo || leeresSeo())

    const offen = Object.entries(seo.pages)
      .filter(([, p]) => (!p.titel || !p.beschreibung) && p.indexierbar !== false)
      .slice(0, 40)
    if (!offen.length) return res.json({ gefuellt: 0, seo })

    const wurzel = quellPfad(req.params.id)
    let gefuellt = 0
    // Abbruch-Erkennung wie beim Chat: auf das Schliessen der ANTWORT horchen.
    // req.destroyed wäre schon nach dem Einlesen des Bodys wahr und würde die
    // Schleife sofort beenden – exakt derselbe Stolperstein wie beim Stopp-Knopf.
    let abgebrochen = false
    res.on('close', () => { if (!res.writableEnded) abgebrochen = true })
    for (const [datei, p] of offen) {
      if (abgebrochen) break   // Browser weg -> keine weiteren Aufrufe bezahlen
      let inhalt = ''
      try {
        inhalt = (await fs.readFile(path.join(wurzel, datei), 'utf8'))
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .slice(0, 6000)
      } catch { continue }

      const { text } = await chatStreamen({
        anbieter, modell,
        system: 'Du bist SEO-Spezialist für Schweizer Websites. Antworte NUR mit einem JSON-Objekt '
          + '{"titel": "...", "beschreibung": "..."} ohne weiteren Text. Schweizer Hochdeutsch (ss statt ß). '
          + 'Titel 50–60 Zeichen, wichtigstes Suchwort vorne. Beschreibung 120–160 Zeichen, aktiv, '
          + 'mit erkennbarem Nutzen. Keine Superlative.',
        nachrichten: [{ rolle: 'user', text: `Seite "${datei}" der Website ${seo.site.name || ''}. Inhalt:\n\n${inhalt}` }],
      })
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) continue
      try {
        const v = JSON.parse(m[0])
        if (!p.titel && v.titel) { p.titel = String(v.titel).slice(0, 70); gefuellt++ }
        if (!p.beschreibung && v.beschreibung) { p.beschreibung = String(v.beschreibung).slice(0, 180); gefuellt++ }
      } catch { /* unbrauchbare Antwort – Seite auslassen */ }
    }

    projekt.seo = seo
    await projektSchreiben(req.params.id, projekt)
    res.json({ gefuellt, seo })
  } catch (e) {
    res.status(500).json({ fehler: fehlerText(e) })
  }
})

// ---------------------------------------------------------------------------
// Produktions-Build
// ---------------------------------------------------------------------------


app.post('/api/projekte/:id/build', (req, res) => nacheinander(req.params.id, async () => {
  try {
    const projekt = await projektLesen(req.params.id)
    if (!projekt) return res.status(404).json({ fehler: 'Projekt nicht gefunden.' })
    const bericht = await buildErzeugen(projekt)
    // Nach dem Bauen: SEO in den Build schreiben (nie in die Quelle).
    if (projekt.seo) {
      bericht.seo = await seoAnwenden(projekt.seo, buildPfad(req.params.id))
    }
    projekt.letzterBuild = bericht.erstelltAm
    await projektSchreiben(req.params.id, projekt)
    res.json(bericht)
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
}))

// Den letzten Build-Bericht abrufen (ohne neu zu bauen).
app.get('/api/projekte/:id/build', async (req, res) => {
  try {
    const datei = path.join(buildPfad(req.params.id), '.build-bericht.json')
    const roh = await fs.readFile(datei, 'utf8')
    res.json(JSON.parse(roh))
  } catch {
    res.json(null)   // noch kein Build
  }
})

// ---------------------------------------------------------------------------
// Baustein-Bibliothek (fuer VinWebMidi, Etappe 2)
// ---------------------------------------------------------------------------
// Die Agentur erntet aus fertigen Seiten Design-Bausteine, prueft und benennt
// sie hier und gibt sie frei. Ergebnis: bibliothek.json im Projektordner -
// daraus komponiert VinWebMidi spaeter neue Unterseiten (KI waehlt nur
// Bausteine, schreibt nie eigenes HTML).

// Die Bibliothek samt Etiketten-Vokabular lesen.
app.get('/api/projekte/:id/bausteine', async (req, res) => {
  try {
    const bibliothek = await bibliothekLesen(req.params.id)
    res.json({ bausteine: bibliothek.bausteine, etiketten: ETIKETTEN })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

// Eine Seite analysieren: liefert Baustein-KANDIDATEN (nichts wird gespeichert).
app.post('/api/projekte/:id/bausteine/analyse', async (req, res) => {
  try {
    const wurzel = quellPfad(req.params.id)
    const ziel = pfadPruefen(wurzel, String(req.body?.seite || ''))
    if (!ziel || !/\.html?$/i.test(ziel.rel)) {
      return res.status(400).json({ fehler: 'Bitte eine HTML-Seite angeben.' })
    }
    const quelltext = await fs.readFile(ziel.voll, 'utf8')
    const bibliothek = await bibliothekLesen(req.params.id)
    // Schon freigegebene Stellen derselben Seite nicht nochmals vorschlagen.
    const bekannt = new Set(bibliothek.bausteine
      .filter(b => b.seite === ziel.rel).map(b => b.selektor))
    const kandidaten = sektionenErnten(quelltext)
      .filter(k => !bekannt.has(k.selektor))
    res.json({ seite: ziel.rel, kandidaten })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
})

// Einen Kandidaten freigeben - er wandert benannt in die Bibliothek.
app.post('/api/projekte/:id/bausteine', (req, res) => nacheinander(req.params.id, async () => {
  try {
    const b = req.body?.baustein
    const name = String(b?.name || '').trim()
    if (!b || !name || !b.seite || !b.selektor || !Array.isArray(b.pfad)) {
      return res.status(400).json({ fehler: 'Unvollständiger Baustein.' })
    }
    const bibliothek = await bibliothekLesen(req.params.id)
    if (bibliothek.bausteine.some(x => x.seite === b.seite && x.selektor === b.selektor)) {
      return res.json({ fehler: 'Diese Sektion ist schon in der Bibliothek.' })
    }
    const eintrag = {
      id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name.slice(0, 80),
      seite: String(b.seite),
      selektor: String(b.selektor),
      pfad: b.pfad,
      etiketten: (Array.isArray(b.etiketten) ? b.etiketten : [])
        .filter(e => ETIKETTEN.some(v => v.wert === e)).slice(0, 4),
      fuellstellen: (Array.isArray(b.fuellstellen) ? b.fuellstellen : []).slice(0, 30),
      zeichen: Number(b.zeichen) || 0,
      bilder: Number(b.bilder) || 0,
      videos: Number(b.videos) || 0,
      freigegebenAm: new Date().toISOString(),
    }
    bibliothek.bausteine.push(eintrag)
    await bibliothekSchreiben(req.params.id, bibliothek)
    res.json({ ok: true, baustein: eintrag })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
}))

// Name oder Etiketten eines Bausteins nachtraeglich aendern.
app.put('/api/projekte/:id/bausteine/:bid', (req, res) => nacheinander(req.params.id, async () => {
  try {
    const bibliothek = await bibliothekLesen(req.params.id)
    const eintrag = bibliothek.bausteine.find(b => b.id === req.params.bid)
    if (!eintrag) return res.status(404).json({ fehler: 'Baustein nicht gefunden.' })
    const name = String(req.body?.name ?? '').trim()
    if (name) eintrag.name = name.slice(0, 80)
    if (Array.isArray(req.body?.etiketten)) {
      eintrag.etiketten = req.body.etiketten
        .filter(e => ETIKETTEN.some(v => v.wert === e)).slice(0, 4)
    }
    await bibliothekSchreiben(req.params.id, bibliothek)
    res.json({ ok: true, baustein: eintrag })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
}))

// Einen Baustein aus der Bibliothek entfernen (die Seite bleibt unberuehrt).
app.delete('/api/projekte/:id/bausteine/:bid', (req, res) => nacheinander(req.params.id, async () => {
  try {
    const bibliothek = await bibliothekLesen(req.params.id)
    const vorher = bibliothek.bausteine.length
    bibliothek.bausteine = bibliothek.bausteine.filter(b => b.id !== req.params.bid)
    if (bibliothek.bausteine.length === vorher) {
      return res.status(404).json({ fehler: 'Baustein nicht gefunden.' })
    }
    await bibliothekSchreiben(req.params.id, bibliothek)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ fehler: e.message })
  }
}))

// ---------------------------------------------------------------------------
// Automatische Sicherung
// ---------------------------------------------------------------------------
// Läuft alle AUTO_SICHERN_SEKUNDEN (Standard: 5 Minuten) über alle Projekte
// und hält fest, was sich seit dem letzten Stand geändert hat – auch Arbeit
// aus dem Editor, aus Claude Design oder dem eingebauten Bild-Editor.
// Gibt es nichts Neues, entsteht auch kein Stand.

async function automatischSichern () {
  let eintraege
  try {
    eintraege = await fs.readdir(PROJECTS_DIR, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of eintraege) {
    if (!e.isDirectory()) continue
    const id = e.name
    try {
      if (!await istRepo(id)) continue
      if (!await hatAenderungen(id)) continue
      await nacheinander(id, () => sichern(id, 'Automatisch gesichert'))
    } catch { /* dieses Projekt überspringen, die anderen weiter prüfen */ }
  }
}

if (AUTO_SICHERN_SEKUNDEN > 0) {
  setInterval(automatischSichern, AUTO_SICHERN_SEKUNDEN * 1000).unref()
}

// ---------------------------------------------------------------------------
// 2) Vorschau-Server
// ---------------------------------------------------------------------------

const vorschau = express()

// ---------------------------------------------------------------------------
// Editor-Brücke: macht die eingebauten Klick-Editoren (Bild anklicken ->
// hochladen) in der Vorschau funktionsfähig. Die Editor-Skripte des Projekts
// speichern über window.omelette.writeFile – diese Brücke liefert genau das
// und reicht die Daten an den Endpunkt unten weiter.
// ---------------------------------------------------------------------------

const BRIDGE_JS = `// VinWeb-Brücke für die eingebauten Bild-Editoren.
// Erlaubt sind nur die .state.json-Sidecars am Projektstamm – das erzwingt
// der Server, nicht dieses Skript.
window.omelette = window.omelette || {};
window.omelette.writeFile = function (name, inhalt) {
  var projekt = decodeURIComponent(location.pathname.split('/')[1] || '');
  return fetch('/__vinweb/schreiben', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projekt: projekt, name: name, inhalt: inhalt })
  }).then(function (r) { if (!r.ok) throw new Error('Speichern fehlgeschlagen'); });
};

// ---------------------------------------------------------------------------
// Text direkt bearbeiten: Doppelklick auf einen Text -> tippen ->
// Klick daneben speichert, Esc bricht ab. Gespeichert wird in der QUELLDATEI,
// und nur, wenn der alte Text dort GENAU EINMAL vorkommt - das erzwingt der
// Server. JS-erzeugte Bereiche (z. B. die Fusszeile) lehnt er dadurch sauber ab.
// ---------------------------------------------------------------------------
(function () {
  var TAGS = 'h1,h2,h3,h4,p,li,blockquote,figcaption,td,th,dt,dd,a,span,strong,em,b,small,button';
  var aktiv = null;   // { el, alt }

  function meldung (text, gut) {
    var m = document.createElement('div');
    m.textContent = text;
    m.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);' +
      'background:' + (gut ? '#1F7A5A' : '#B3261E') + ';color:#fff;padding:9px 16px;' +
      'border-radius:4px;font:13px/1.4 -apple-system,sans-serif;z-index:99999;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.25);max-width:80vw';
    document.body.appendChild(m);
    setTimeout(function () { m.remove(); }, gut ? 1800 : 4200);
  }

  function seitenPfad () {
    return decodeURIComponent(location.pathname.split('/').slice(2).join('/')) || 'index.html';
  }

  function beenden (speichern) {
    if (!aktiv) return;
    var el = aktiv.el, alt = aktiv.alt;
    aktiv = null;
    el.contentEditable = 'false';
    el.style.outline = '';
    el.style.cursor = '';
    var neu = el.innerHTML;
    if (!speichern || neu === alt) {
      if (!speichern) el.innerHTML = alt;
      return;
    }
    fetch('/__vinweb/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projekt: decodeURIComponent(location.pathname.split('/')[1] || ''),
        seite: seitenPfad(),
        alt: alt,
        neu: neu
      })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        el.style.outline = '2px solid #1F7A5A';
        setTimeout(function () { el.style.outline = ''; }, 900);
        meldung('Gespeichert - im Verlauf gesichert.', true);
      } else {
        el.innerHTML = alt;
        meldung(d.fehler || 'Nicht speicherbar - bitte über den Chat ändern.', false);
      }
    }).catch(function () {
      el.innerHTML = alt;
      meldung('Speichern fehlgeschlagen - läuft VinWeb noch?', false);
    });
  }

  document.addEventListener('dblclick', function (e) {
    if (aktiv) return;
    var el = e.target && e.target.closest ? e.target.closest(TAGS) : null;
    if (!el || el.closest('[contenteditable="true"]')) return;
    // Bereiche mit Medien oder eigener Technik gehören dem Chat, nicht dem Doppelklick.
    if (el.querySelector('img,svg,canvas,video,script,iframe,style,image-slot,scroll-shot')) {
      meldung('Dieser Bereich enthält Bilder oder Technik - bitte über den Chat ändern.', false);
      return;
    }
    if (el.innerHTML.length > 8000) return;
    e.preventDefault();
    aktiv = { el: el, alt: el.innerHTML };
    el.contentEditable = 'true';
    el.style.outline = '2px solid #3FBDB6';
    el.style.outlineOffset = '2px';
    el.style.cursor = 'text';
    el.focus();
  });

  document.addEventListener('focusout', function (e) {
    if (aktiv && e.target === aktiv.el) setTimeout(function () { beenden(true); }, 0);
  });
  document.addEventListener('keydown', function (e) {
    if (!aktiv) return;
    if (e.key === 'Escape') { e.preventDefault(); beenden(false); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); aktiv.el.blur(); }
  });
})();
`

vorschau.get('/__vinweb/bridge.js', (req, res) => {
  res.type('application/javascript; charset=utf-8').send(BRIDGE_JS)
})

// ---------------------------------------------------------------------------
// Baustein-Miniatur: Eine Seite wird mit ?__baustein=<selektor> aufgerufen,
// dieses Skript blendet dann ALLES ausser der gewuenschten Sektion aus.
// Bewusst die ECHTE Seite mit allen Skripten (image-slots, Deko, Farbmodus) -
// nur so sieht die Miniatur exakt aus wie die Sektion auf der Website.
// Die gemessene Hoehe geht per postMessage an die Oberflaeche (keine
// Geheimnisse darin, darum targetOrigin '*').
// ---------------------------------------------------------------------------

const BAUSTEIN_JS = `// VinWeb-Baustein-Miniatur: zeigt nur eine Sektion der Seite.
(function () {
  function anwenden () {
    var sel = window.__vinwebBaustein
    var ziel
    try { ziel = document.querySelector(sel) } catch (e) {}
    if (!ziel) return
    var k = ziel
    while (k && k !== document.body && k.parentElement) {
      var eltern = k.parentElement
      for (var i = 0; i < eltern.children.length; i++) {
        if (eltern.children[i] !== k) eltern.children[i].style.setProperty('display', 'none', 'important')
      }
      k.style.setProperty('margin', '0', 'important')
      k = eltern
    }
    document.documentElement.style.overflow = 'hidden'
    document.body.style.setProperty('min-height', '0', 'important')
    window.scrollTo(0, 0)
    function melden () {
      try {
        parent.postMessage({ typ: 'vinweb-baustein-masse', sel: sel,
          hoehe: ziel.getBoundingClientRect().height }, '*')
      } catch (e) {}
    }
    // Mehrfach melden: Schriften und Bilder aendern die Hoehe nach dem Laden.
    melden(); setTimeout(melden, 600); setTimeout(melden, 2000)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', anwenden)
  } else { anwenden() }
})()
`

vorschau.get('/__vinweb/baustein.js', (req, res) => {
  res.type('application/javascript; charset=utf-8').send(BAUSTEIN_JS)
})

// Nimmt die Sidecar-Daten der Editoren entgegen. Bewusst eng:
// nur Dateinamen der Form ".xyz.state.json", nur am Projektstamm,
// und durch die Projekt-Schlange – kollidiert nie mit Build oder Sicherung.
vorschau.post('/__vinweb/schreiben', express.json({ limit: '40mb' }), (req, res) => {
  const projekt = path.basename(String(req.body?.projekt || ''))
  const name = path.basename(String(req.body?.name || ''))
  const inhalt = req.body?.inhalt
  if (!projekt || typeof inhalt !== 'string') {
    return res.status(400).json({ fehler: 'Unvollständige Anfrage.' })
  }
  if (!/^\.[a-z0-9-]+\.state\.json$/i.test(name)) {
    return res.status(403).json({ fehler: 'Nur .state.json-Dateien erlaubt.' })
  }
  return nacheinander(projekt, async () => {
    try {
      await fs.writeFile(path.join(quellPfad(projekt), name), inhalt, 'utf8')
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ fehler: e.message })
    }
  })
})

// Nimmt Textänderungen aus der Vorschau entgegen. Bewusst streng:
// Die Änderung wird NUR geschrieben, wenn der alte Ausschnitt in der
// Quelldatei GENAU EINMAL vorkommt – sonst Ablehnung statt Raterei.
vorschau.post('/__vinweb/text', express.json({ limit: '1mb' }), (req, res) => {
  const projekt = path.basename(String(req.body?.projekt || ''))
  const seite = String(req.body?.seite || '')
  const alt = String(req.body?.alt ?? '')
  const neu = String(req.body?.neu ?? '')

  if (!projekt || !alt) return res.status(400).json({ fehler: 'Unvollständige Anfrage.' })
  if (alt.length > 20000 || neu.length > 20000) {
    return res.status(413).json({ fehler: 'Der Abschnitt ist zu gross für die Direktbearbeitung.' })
  }

  const wurzel = quellPfad(projekt)
  const ziel = pfadPruefen(wurzel, seite)
  if (!ziel || !/\.html?$/i.test(ziel.rel)) {
    return res.status(400).json({ fehler: 'Nur HTML-Seiten sind direkt bearbeitbar.' })
  }

  return nacheinander(projekt, async () => {
    try {
      const inhalt = await fs.readFile(ziel.voll, 'utf8')
      const treffer = inhalt.split(alt).length - 1
      if (treffer === 0) {
        return res.json({
          fehler: 'Dieser Text steht so nicht in der Quelldatei – vermutlich wird er '
            + 'von einem Skript erzeugt (z. B. Fusszeile). Bitte über den Chat ändern.',
        })
      }
      if (treffer > 1) {
        return res.json({
          fehler: `Dieser Text kommt ${treffer}-mal auf der Seite vor – nicht eindeutig. `
            + 'Bitte über den Chat ändern (dort lässt sich die Stelle benennen).',
        })
      }
      await fs.writeFile(ziel.voll, inhalt.replace(alt, neu), 'utf8')
      if (await istRepo(projekt)) {
        await sichern(projekt, 'Text angepasst: ' + ziel.rel)
      }
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ fehler: e.message })
    }
  })
})

// Für jedes Projekt wird beim ersten Aufruf ein Datei-Ausliefer-Dienst angelegt
// und gemerkt.
const ausliefererCache = new Map()
function ausliefererFuer (id) {
  if (!ausliefererCache.has(id)) {
    ausliefererCache.set(id, express.static(quellPfad(id), {
      index: ['index.html'],
      dotfiles: 'allow',   // die .state.json-Dateien des Editors muessen ladbar sein
      etag: false,
      // Während der Arbeit wollen wir immer den aktuellen Stand sehen.
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
    }))
  }
  return ausliefererCache.get(id)
}

const buildCache = new Map()
function buildAusliefererFuer (id) {
  if (!buildCache.has(id)) {
    buildCache.set(id, express.static(buildPfad(id), {
      index: ['index.html'],
      extensions: ['html'],    // saubere Adressen: /kontakt findet kontakt.html
      dotfiles: 'allow',       // die Slot-Sidecars (.state.json) gehören zur Website
      etag: false,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    }))
  }
  return buildCache.get(id)
}

vorschau.use(async (req, res, next) => {
  const [roh, abfrage] = req.url.split('?')

  // ERST dekodieren, DANN prüfen. Wer vor dem Dekodieren prüft, ist blind für
  // Schreibweisen wie %2F: ".git%2Fconfig" sieht aus wie ein Dateiname, wird
  // vom Dateiserver aber wieder zu ".git/config" – und die Sperre griffe nicht.
  let pfad
  try {
    pfad = decodeURIComponent(roh)
  } catch {
    return res.status(400).type('text/plain; charset=utf-8').send('Ungültige Adresse.')
  }
  const teile = pfad.split('/').filter(Boolean)

  if (teile.length === 0) {
    return res.status(404).type('text/plain; charset=utf-8')
      .send('VinWeb-Vorschau. Der Aufruf lautet /<projekt>/<seite>.')
  }

  const id = teile[0]

  // Sonderweg: /<id>/__build__/... liefert aus dem fertigen Build statt aus der
  // Quelle. So lässt sich der Produktions-Stand ansehen, ohne die Quelle zu berühren.
  if (teile[1] === '__build__') {
    if (teile.some(t => t === '..' || t.toLowerCase() === '.git')) return res.status(404).end()
    if (/\.php$/i.test(pfad)) {
      return res.status(501).type('text/plain; charset=utf-8')
        .send('PHP wird in der örtlichen Vorschau nicht ausgeführt.')
    }
    req.url = '/' + teile.slice(2).map(encodeURIComponent).join('/') + (abfrage ? '?' + abfrage : '')
    return buildAusliefererFuer(id)(req, res, next)
  }

  // Der Verlauf (.git) ist die Buchhaltung von VinWeb, nie Teil der Website.
  // Ohne diese Sperre könnte ein Skript aus einem importierten ZIP die
  // komplette Projektgeschichte auslesen – samt Ständen längst gelöschter
  // Dateien. Kleinschreibung prüfen, weil das Mac-Dateisystem .GIT und .git
  // gleich behandelt. ".."-Segmente ebenfalls abweisen.
  if (teile.some(t => t === '..' || t.toLowerCase() === '.git')) {
    return res.status(404).end()
  }

  // PHP kann ein reiner Dateiserver nicht ausfuehren. Wir liefern die Datei
  // bewusst NICHT als Text aus - in config.php stehen Zugangsdaten.
  if (/\.php$/i.test(pfad)) {
    return res.status(501).type('text/plain; charset=utf-8')
      .send('PHP wird in der örtlichen Vorschau nicht ausgeführt. Auf dem Server funktioniert es.')
  }

  // HTML-Seiten der Quelle bekommen die Editor-Brücke eingesetzt – damit
  // funktioniert "Bild anklicken -> hochladen" direkt in der Vorschau.
  const relPfad = teile.length === 1 ? 'index.html' : teile.slice(1).join('/')
  if (/\.html?$/i.test(relPfad)) {
    try {
      let inhalt = await fs.readFile(path.join(quellPfad(id), relPfad), 'utf8')
      // Die Brücke MUSS vor den Editor-Skripten laufen: image-slot entscheidet
      // genau einmal beim Aufbau, ob es bearbeitbar ist – käme die Brücke erst
      // am Seitenende, blieben alle Slots dauerhaft schreibgeschützt.
      let brueckenTag = '<script src="/__vinweb/bridge.js"></script>'
      // Baustein-Miniatur gewuenscht? Selektor sicher (als JSON) uebergeben.
      const bausteinSel = new URLSearchParams(abfrage || '').get('__baustein')
      if (bausteinSel) {
        brueckenTag += '\n<script>window.__vinwebBaustein = '
          + JSON.stringify(bausteinSel).replace(/</g, '\\u003c')
          + '</script>\n<script src="/__vinweb/baustein.js"></script>'
      }
      if (/<head[^>]*>/i.test(inhalt)) {
        inhalt = inhalt.replace(/<head([^>]*)>/i, '<head$1>\n' + brueckenTag)
      } else if (inhalt.includes('</body>')) {
        inhalt = inhalt.replace('</body>', brueckenTag + '\n</body>')
      } else {
        inhalt += '\n' + brueckenTag
      }
      return res.type('text/html; charset=utf-8')
        .set('Cache-Control', 'no-store').send(inhalt)
    } catch { /* Datei gibt es nicht – normale 404-Behandlung unten */ }
  }

  const rest = '/' + teile.slice(1).map(encodeURIComponent).join('/')
  req.url = rest + (abfrage ? '?' + abfrage : '')
  ausliefererFuer(id)(req, res, next)
})

vorschau.use((req, res) => {
  res.status(404).type('text/html; charset=utf-8')
    .send('<html lang="de"><body style="font:15px system-ui;padding:40px;color:#5B5E66">'
      + '<h2 style="color:#17181B">Seite nicht gefunden</h2>'
      + '<p>Diese Datei gibt es im Projekt nicht.</p></body></html>')
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

await fs.mkdir(PROJECTS_DIR, { recursive: true })

function startFehler (port) {
  return (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error('')
      console.error(`  Port ${port} ist schon belegt.`)
      console.error('  Vermutlich läuft VinWeb bereits in einem anderen Fenster.')
      console.error(`  Beenden mit:  lsof -ti tcp:${port} | xargs kill`)
      console.error('')
    } else {
      console.error('  Start fehlgeschlagen:', e.message)
    }
    process.exit(1)
  }
}

const uiServer = app.listen(UI_PORT, HOST, () => {
  console.log('')
  console.log('  VinWeb läuft.')
  console.log('')
  console.log(`  Oberfläche   http://${HOST}:${UI_PORT}`)
  console.log(`  Vorschau      http://${HOST}:${PREVIEW_PORT}`)
  console.log('')
  console.log('  Beenden mit  Ctrl + C')
  console.log('')
})

const vorschauServer = vorschau.listen(PREVIEW_PORT, HOST)
uiServer.on('error', startFehler(UI_PORT))
vorschauServer.on('error', startFehler(PREVIEW_PORT))
