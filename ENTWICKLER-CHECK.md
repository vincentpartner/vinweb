# VinWeb — Unterlagen für den Entwickler-Check

Stand: 09.09.2026 · Kontakt: Reto Puma (r.puma@vincent-partner.ch)
Zweck dieses Dokuments: einem externen Entwickler den Einstieg für ein
Code-Review geben — Architektur, Datenflüsse, Sicherheitsmechanismen und die
Stellen, auf die sich ein Review konzentrieren sollte.

## Was VinWeb ist

Ein lokales Werkzeug (Node/Express, Vanilla-JS-Oberfläche, bewusst ohne
Framework und ohne Build-Schritt), das Website-Exporte aus «Claude Design»
in produktionsreife statische Websites überführt: Import → Analyse →
Inhaltspflege (KI-Chat mit Diff-Freigabe, Klick-Editoren) → SEO →
Produktions-Build → KI-Endprüfung → Staging → Live (rsync/SSH auf Shared
Hosting). Git dient als Verlauf/Undo je Projekt und als Fernsicherung (GitHub).

## Setup

- Voraussetzungen: Node ≥ 20 (getestet mit 24), git, rsync/ssh (macOS-Bordmittel)
- `npm install && npm start` (läuft mit `node --watch`) → http://127.0.0.1:4400
- API-Schlüssel (Anthropic/OpenAI) werden in der Oberfläche erfasst und liegen
  in `~/.vinweb/keys.json` (0600) — bewusst ausserhalb des Repos, nie im Code.
- Kundenprojekte liegen unter `projects/<id>/` (gitignored, NICHT im ZIP):
  `source/` (Arbeitsstand, eigenes Git-Repo) · `build/` (generiert) ·
  `projekt.json` (Metadaten, Analyse, SEO-Modell, Deploy-Ziele).

## Architektur in einem Bild

```
Browser-UI (ui/, Port 4400) ──REST/SSE──▶ server.js
                                            ├─ lib/* (Fachlogik, s. unten)
                                            ├─ Warteschlange je Projekt («nacheinander»)
                                            └─ Auto-Sicherung (git commit alle 5 min)
Vorschau (Port 4401) ── liefert projects/<id>/source bzw. build aus
  └─ injiziert /__vinweb/bridge.js in Quell-HTML (Editoren + Doppelklick-Text)
Extern: Anthropic/OpenAI-API · GitHub (push) · Cyon (rsync/ssh) · Hostpoint (Kalender-API, unangetastet)
```

Zwei Ports = zwei Browser-Origins: Skripte aus importierten (fremden!) ZIPs
laufen auf 4401 und erreichen die Oberfläche/Schlüssel auf 4400 nicht.

## Module (lib/)

| Modul | Aufgabe |
|---|---|
| config.js | Ports, Pfade, Intervalle |
| projects.js | Projektverwaltung, Pfad-Härtung (`basename`) |
| importer.js | ZIP-Import; Zip-Slip-Schutz, `.git`/Junk-Filter |
| vergleich.js | «Design-Update»: neues ZIP gegen Projekt, Konflikt = seit Import auch lokal geändert |
| analyze.js | Befunde (Zugangsdaten-Scans, fremde Quellen, Waisenseiten …) |
| git.js | Verlauf je Projekt: sichern/zurücksetzen (revert-artig, nie destruktiv), push |
| ai.js | Claude/OpenAI: Modelle live, Streaming, Abbruch-Signal, Kosten |
| aenderungen.js | KI-Antworten zerlegen (VINWEB-DATEI-Blöcke), Diffs, Anwenden mit Pfad-Härtung |
| build.js | Build: kopieren n. Auswahl, Einbacken, Fremdquellen lokal laden, Bilder verkleinern (sharp), Kleinschreibung + Link-Nachzug, saubere Adressen ohne .html |
| einbacken.js | Editor-Sidecars (.state.json) → echte Dateien/`src`-Attribute im Build |
| seo.js | SEO-Modell, SiteSett-Import (Merge!), Head-Anreicherung, sitemap/robots/404/.htaccess |
| endpruefung.js | Vor-Go-Live-Prüfung: mechanisch + KI (Modellwahl), Bericht an Verlaufs-Stand gebunden |
| fortschritt.js | Startseiten-«Weg zum Go-Live» (9 Schritte, teils berechnet, teils Abhaken) |
| deploy.js | rsync/ssh zu Staging (Suchmaschinen-Schutz automatisch); Live analog |
| ernte.js | Inhalte fremder Websites einsammeln (robots.txt-konform, gedrosselt, stoppbar) |
| keys.js / geheim.js | Schlüsselablage (0600) / gemeinsame Geheimnis-Muster |
| bausteine.js | Design-Bausteine für das Kunden-Tool «VinWebMidi» (separates Projekt) |

## Datenmodell-Eckpunkte

- **Quelle ist heilig:** SEO, saubere Adressen, Einbacken passieren NUR im Build
  (`projects/<id>/build`, bei jedem Lauf komplett neu erzeugt).
- **Sidecars** (`.image-slots-*.state.json` …): Arbeitsdaten der Klick-Editoren
  aus Claude Design; VinWeb liefert die Speicher-Gegenstelle (`bridge.js`,
  nur Sidecar-Dateinamen am Projektstamm, serverseitig erzwungen).
- **projekt.json**: Analyse-Bericht, SEO-Modell, Datei-Zuordnung (Repo/Server
  je Eintrag), Deploy-Ziele, Endprüfungs-Bericht (mit Verlaufs-Hash).

## Sicherheitsmechanismen (bewusste Entscheidungen)

1. Schlüssel nie im Repo/Chat/Frontend; UI erhält nur maskierte Anzeige.
2. Import: Zip-Slip-Schutz, `.git/` aus Archiven nie entpackt (Hook-Angriffe),
   Resolve-Check unter Projektwurzel.
3. KI darf nur via Diff-Freigabe schreiben; Zielpfade durch `pfadPruefen`
   (kein `..`, kein `.git`, nur Projektwurzel); Dateien mit Zugangsdaten
   werden der KI nie übergeben (auch nicht auf Anforderung — Namens- und
   Inhaltsmuster in geheim.js/analyze.js).
4. Systemprompts markieren Seiteninhalte als Daten, nicht Anweisungen
   (Prompt-Injection-Dämpfung); Datei-Nachreichen max. 1 Runde, 6 Dateien.
5. Deploy: execFile (nie Shell), Host/Pfad-Format-Whitelist, Staging erhält
   automatisch robots-Disallow + X-Robots-Tag.
6. Vorschau: `.git` gesperrt, PHP wird nie ausgeliefert (config-Schutz),
   Build-Ansicht ohne Brücke = schreibgeschützt.
7. Verlauf statt Löschen: Zurücksetzen erzeugt neue Stände; Auto-Sicherung
   vor/nach schreibenden Aktionen; alles in Projekt-Warteschlangen
   serialisiert (keine Halb-Stände durch Parallelläufe).

## Vorschläge für Review-Schwerpunkte

1. **Angriffsfläche Vorschau-Server (4401):** bridge-Schreibendpunkt
   (`/__vinweb/schreiben`, `/__vinweb/text`) — Pfad-/Formatgrenzen ausreichend?
2. **deploy.js:** rsync/ssh-Argumente, Whitelists, Fehlerpfade.
3. **einbacken.js / build.js:** Regex-Chirurgie auf HTML — Ecken, in denen
   Ersetzungen fehlgreifen könnten (verschachtelte Anführungszeichen etc.).
4. **KI-Fluss (server.js /api/chat):** Nachreich-Schleife, Abbruch über
   `res.close`, Kosten-/Limit-Verhalten.
5. **git.js zurücksetzen:** Randfälle (untracked, gelöschte Dateien, grosse Binärstände).
6. Allgemein: Fehlerbehandlung der SSE-Endpunkte, Warteschlangen-Semantik.

## Bekannte, bewusste Grenzen

- Einzelplatz-Werkzeug, kein Login/Mandantenschutz — läuft nur auf 127.0.0.1.
- UI ohne Framework: bewusst; app.js ist gross, Modularisierung wäre Kür.
- Sprachstufe (mehrsprachige Sites, hreflang) noch nicht gebaut.
- Tests: gezielte End-zu-End-Prüfungen per Skript statt Test-Suite.

## Was in diesem ZIP fehlt — mit Absicht

- `projects/`, `ernte/` (Kundendaten), `node_modules/`, jegliche Schlüssel.
- Volle Git-Historie liegt auf GitHub (privates Repo `vincentpartner/vinweb`) —
  für ein tieferes Review lädt Reto den Prüfer dort als Read-only-Collaborator ein.
