# VinWeb — Doku für den Entwickler-Check

Stand: 9. September 2026 · Dieses Paket ist der komplette Code des Werkzeugs,
ohne Kundendaten (siehe «Was fehlt bewusst» ganz unten).

## Was ist VinWeb?

Eine **lokale** Node-App (bewusst ohne Framework, alle Kommentare Deutsch),
mit der die Agentur Vincent & Partner Websites betreut: ZIP-Export aus
Claude Design importieren → prüfen → Vorschau mit Klick-Editoren → SEO aus
SiteSett einprägen → Produktions-Build → per KI-Chat anpassen (Diff mit
Freigabe) → Git-Verlauf → GitHub-Fernlager → Deploy per rsync auf das
Hosting (cyon). Mehrere Kundenprojekte, ein Git-Repo pro Website.

Zur Familie gehören zwei Schwester-Apps (nicht in diesem Paket):
**VinWebMini/Midi** — das Kunden-Werkzeug (gleiche Technik, Ports 4500/4501),
das direkt auf demselben Projektordner bzw. im Fernbetrieb über dasselbe
GitHub-Repo arbeitet. Sie werden später von einem Programmierer als
Cloud-Version neu gebaut; dieses Werkzeug hier bleibt das Agentur-Werkzeug.

## Schnellstart

Voraussetzungen: Node ≥ 20, git, rsync (für Deploy), macOS/Linux.

```bash
npm install
npm start          # node --watch server.js
```

Oberfläche: http://127.0.0.1:4400 · Vorschau: http://127.0.0.1:4401
(beide NUR auf 127.0.0.1 gebunden).

Ohne Projekt ist die App leer — zum Testen ein beliebiges Website-ZIP
(index.html im Stamm) über «Import & Ernte» hereinziehen.

API-Schlüssel (Claude/OpenAI/GitHub-Token) liegen in `~/.vinweb/keys.json`
(Modus 600) — **nie** im Projekt, nie im Repo; Eingabe über das ⚙ in der
Oberfläche.

## Architektur und Sicherheitsmodell

Das ist der Kern, den der Check bestätigen (oder widerlegen) soll:

1. **Zwei Server = zwei Herkünfte.** 4400 (Oberfläche/API) und 4401
   (Vorschau der Kundenwebsite). Ein Skript aus einem importierten ZIP läuft
   nur auf 4401 und kommt per Same-Origin-Policy nie an die API oder die
   Schlüssel der Oberfläche heran. Das ist die wichtigste Grenze im System.
2. **Dekodieren VOR dem Prüfen.** Die Vorschau dekodiert URLs zuerst und
   weist dann `.git`, `..` und `.php` ab — auch getarnt als `%2E`/`%2F`/
   `%252F` (server.js, Vorschau-Middleware).
3. **Kein Shell-Aufruf.** git, rsync, ssh laufen über `execFile` mit
   Argument-Arrays — keine Kommando-Injektion möglich. Hash-Parameter werden
   per Regex `^[0-9a-f]{7,40}$` gefiltert; Deploy-Host/-Pfad werden gegen
   enge Muster geprüft (lib/deploy.js `zielPruefen`).
4. **Schreibpfade.** `pfadPruefen` (lib/aenderungen.js) hält jede Schreib-
   operation im Projektordner; nichts darf in `.git` zeigen (Git-Hooks wären
   sonst Code-Ausführung). Der ZIP-Import entpackt keinen `.git`-Ordner und
   hat Zip-Slip-Schutz (lib/importer.js).
5. **Warteschlange je Projekt** (`nacheinander` in server.js): alles, was
   schreibt (Übernehmen, Sichern, Build, Deploy, Fernlager), läuft seriell —
   die Auto-Sicherung erwischt nie einen halben Stand. Git-Aufrufe haben
   einen index.lock-Wiederholversuch (Mini schreibt ins selbe Repo).
6. **Verlauf ist nie destruktiv.** Zurücksetzen schreibt den alten Stand als
   neuen obendrauf (lib/git.js).
7. **Fernlager-Token** (GitHub) wird pro Aufruf als HTTP-Extraheader
   übergeben und landet **nie** in `.git/config` (lib/git.js `authArgumente`).
8. **Zugangsdaten-Erkennung:** lib/geheim.js definiert das eine Muster für
   Dateien mit Zugangsdaten; Analyse und Build halten solche Dateien aus
   Repo und KI-Kontext heraus. Der KI-Chat reicht angeforderte Dateien
   automatisch nach — Zugangsdaten-Dateien nie.
9. **Staging-Schutz:** jeder Staging-Deploy setzt robots.txt-Disallow +
   X-Robots-Tag neu; Live bekommt das nie (lib/deploy.js).
10. **Vorschau-Injektionen:** In HTML-Seiten der Vorschau wird
    `/__vinweb/bridge.js` injiziert (Brücke für die eingebauten
    Bild-Editoren; Schreiben nur über enge Endpunkte: `.state.json` am
    Stamm, Text nur bei genau-einmal-Treffer). Mit `?__baustein=<Selektor>`
    zusätzlich `/__vinweb/baustein.js` (blendet für Miniaturen alles ausser
    einer Sektion aus; meldet nur die Höhe per postMessage, keine Daten).

## Ordnerstruktur

```
server.js            Startpunkt: beide Server, alle Endpunkte, Warteschlange
VinWeb.command       Doppelklick-Starter (selbstheilend, curl-Gesundheitscheck)
ui/                  Oberfläche: index.html, app.js, style.css (kein Framework)
lib/aenderungen.js   KI-Vorschläge zerlegen, Diffs zeigen, sicher anwenden
lib/ai.js            Claude + OpenAI (Streaming, eigene Schlüssel)
lib/analyze.js       Prüfbericht nach Import (Befunde, Struktur, Schlüsselfunde)
lib/bausteine.js     Sektions-Ernte für VinWebMidi (Tag-Balancierung, bibliothek.json)
lib/build.js         Produktions-Build (CDN lokalisieren, Bilder, Slugs, Bereinigung)
lib/config.js        Ports und Pfade
lib/deploy.js        rsync über SSH auf Staging/Live (Ziele in projekt.json)
lib/einbacken.js     Klick-Editor-Justierungen (.state.json-Sidecars) in den Build einbacken
lib/endpruefung.js   Mechanische + KI-Endprüfung des Builds vor dem Go-Live
lib/ernte.js         Inhalte bestehender Websites einsammeln (robots.txt, gedrosselt)
lib/fortschritt.js   Der 8-Schritte-Weg zum Go-Live (Startseite)
lib/geheim.js        Muster für Zugangsdaten-Dateien
lib/git.js           Verlauf + GitHub-Fernlager (Sync mit Mini/Midi)
lib/importer.js      ZIP-Import mit Schutzmassnahmen
lib/keys.js          ~/.vinweb/keys.json (600), maskierte Anzeige
lib/projects.js      Projekte anlegen/auflisten, Pfadauflösung
lib/seo.js           SiteSett-Config übernehmen, SEO beim Build einprägen
lib/vergleich.js     Frisches Claude-Design-ZIP gegen das Projekt vergleichen/übernehmen
```

## Endpunkte (Kurzreferenz)

Oberfläche (4400), alle unter `/api`:

- Projekte: `GET /projekte`, `GET|DELETE /projekte/:id`,
  `POST /projekte/:id/analyse`, `PUT /projekte/:id/auswahl`,
  `DELETE /projekte/:id/seiten`, `GET /projekte/:id/zip`,
  `GET|PUT /projekte/:id/fortschritt`
- Import/Ernte: `POST /import`, `POST /import-pfad`, `POST /ernte`,
  `GET /ernten`, `DELETE /ernten/:name`, `POST /ernte/oeffnen`,
  `POST /projekte/:id/vergleich-upload|vergleich|vergleich/uebernehmen`
- KI: `GET /schluessel`, `PUT /schluessel`, `GET /modelle/:anbieter`,
  `GET /projekte/:id/textdateien`, `POST /chat` (SSE), `POST /anwenden`
- SEO: `GET|PUT /projekte/:id/seo`, `POST …/seo/import-sitesett`,
  `POST …/seo/ki-fuellen`
- Build/Go-Live: `POST|GET /projekte/:id/build`,
  `GET|POST /projekte/:id/endpruefung`, `POST /projekte/:id/deploy/staging`
- Verlauf: `GET …/verlauf`, `POST …/sichern`, `GET …/verlauf/:hash/vergleich`,
  `POST …/zurueck`, `POST …/zurueck-datei`
- Fernlager: `GET|POST|DELETE /projekte/:id/fernlager`,
  `POST …/fernlager/abgleichen|uebernehmen|hochladen`
- Bausteine (für Midi): `GET|POST /projekte/:id/bausteine`,
  `POST …/bausteine/analyse`, `PUT|DELETE …/bausteine/:bid`

Vorschau (4401): `/{projektId}/{seite}` (Quelle, mit Editor-Brücke),
`/{projektId}/__build__/{seite}` (fertiger Build), `/__vinweb/bridge.js`,
`/__vinweb/baustein.js`, `POST /__vinweb/schreiben`, `POST /__vinweb/text`.

## Datenformate

- `projects/<id>/projekt.json` — Stammdaten, Analysebericht, Auswahl
  (Repo/Server-Häkchen), SEO-Daten, Fortschritt, `deploy { host, staging,
  stagingUrl, live, liveUrl }`.
- `projects/<id>/source/` — die Website, eigenes Git-Repo (der Verlauf).
- `projects/<id>/build/` — der Produktions-Build (wird erzeugt, nie Quelle).
- `projects/<id>/bibliothek.json` — freigegebene Design-Bausteine für Midi.
- `projects/<id>/mini.json`, `midi-material/` — gehören den Schwester-Apps.

## Sync-Protokoll mit Mini/Midi (Fernlager)

Ein privates GitHub-Repo pro Website ist die Drehscheibe. Regeln:

- Kunde (Mini/Midi): beim Start + zyklisch `fetch`+`merge` (ff bevorzugt),
  nach jeder Aktion stiller `push`. Offline ist kein Fehler.
- Agentur (VinWeb): nach jedem gesicherten Stand stiller Push (nie, wenn
  eingehende Stände da sind); «Abgleichen/Übernehmen/Hochladen» im
  Verlauf-Panel.
- **Konflikt entscheidet immer die Agentur.** Kollidiert der Kunde lokal,
  pusht seine Instanz die festgefahrenen Stände als Zweig `kunde-wartet`
  (`push -f main:kunde-wartet`); VinWeb zeigt «Kunde wartet», führt per
  Knopf zusammen (`-X ours`/`-X theirs`), löscht den Zweig und pusht main —
  der Kunde bekommt die Lösung beim nächsten Takt per Fast-Forward.

## Stand der Etappen / Offenes

Gebaut und getestet: Import/Analyse, Vorschau mit Klick-Editoren,
Design-Update-Vergleich, Ernte, KI-Chat mit Diff-Freigabe, SEO-Vollausbau,
Build inkl. Sidecar-Einbacken, Endprüfung, Verlauf, Fernlager-Sync,
Bausteine-Ernte, Deploy auf **Staging**.

Offen: Live-Deploy-Freigabe (Knopf/Ablauf), Entscheid zum PHP-Kalender-
Backend (lebt auf Hostpoint, flexpep hängt daran), hreflang/Englisch,
Konsolidierung der zwei CSS-Schichten in ui/style.css (alte Schicht +
«NEUES GEWAND»-Überschreibschicht — bekannt, bewusst zurückgestellt).

## Worauf der Check besonders schauen sollte

1. Die Vorschau-Middleware (server.js unten): Dekodier-Reihenfolge,
   `.git`/`..`/`.php`-Sperren, `__build__`-Zweig.
2. `pfadPruefen` und alle Schreib-Endpunkte (`/anwenden`, `/__vinweb/…`,
   SEO/Build/Vergleich): kommt man aus dem Projektordner heraus?
3. `execFile`-Aufrufe (git.js, deploy.js, ernte): Argument-Injektion?
4. Fernlager: Token-Behandlung, `kunde-wartet`-Ablauf, Merge-Strategien.
5. Express-Limits (JSON 60 MB, Import 500 MB raw) und SSE-Abbruchpfade
   (`res.on('close')` mit `writableEnded`-Wächter — bekannte Node-Falle,
   bewusst so gelöst).
6. deploy.js: rsync-Argumente, `--delete`-Verhalten, robots-Schutz.

## Was in diesem Paket bewusst FEHLT

- `projects/` und `ernte/` — echte Kundendaten und -inhalte.
- `node_modules/` — `npm install` stellt alles her (package-lock liegt bei).
- `.git/` des Werkzeugs selbst und lokale Editor-/Session-Ordner.
- Jegliche Schlüssel: liegen ausschliesslich in `~/.vinweb/keys.json` des
  jeweiligen Rechners. Das Paket wurde vor dem Packen auf Schlüsselmuster
  gescannt (sauber).
- `ui/*.vor-umbau` — reine Vorher-Sicherungen.

Fragen gern an Reto Puma (r.puma@vincent-partner.ch).
