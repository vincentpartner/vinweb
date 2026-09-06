# VinWeb

Lokale Oberfläche, um einen Website-Export (ZIP aus Claude Design) zu importieren,
zu prüfen, anzupassen und später über GitHub zu veröffentlichen.

**Stand: Etappen 1–5** — Import, Analyse, Vorschau, Produktions-Build, SEO, KI-Anpassungen und Verlauf funktionieren. Offen: Etappe 6 (Deploy).

## Starten

```bash
npm start
```

Danach im Browser öffnen: <http://127.0.0.1:4400>

Beenden mit `Ctrl + C`.

## Wie es aufgebaut ist

```
server.js          Startpunkt – startet beide Server
lib/config.js      Ports und Pfade
lib/projects.js    Projekte anlegen, auflisten, lesen
lib/importer.js    ZIP entpacken (mit Schutz gegen präparierte Archive)
lib/analyze.js     Prüfbericht: was fehlt noch bis zum Livegang
lib/keys.js        API-Schlüssel (liegen in ~/.vinweb/keys.json, nicht im Projekt)
lib/ai.js          Anbindung an Claude und ChatGPT
lib/aenderungen.js Vorschläge zerlegen, Unterschiede zeigen, schreiben
lib/git.js         Verlauf: Stände sichern, ansehen, zurückholen
lib/build.js       Produktions-Build: lokalisieren, verkleinern, umbenennen
lib/seo.js         SEO: Head-Anreicherung, sitemap, robots, 404, .htaccess, llms.txt
ui/                Oberfläche (reines HTML/CSS/JS, kein Framework)
projects/          hier landen die importierten Projekte
  <projekt>/source/     die Website
  <projekt>/source/.git Verlauf (Git) – jeder Stand vollständig
  <projekt>/versionen/  Rückfallebene, falls kein Git vorhanden ist
  <projekt>/build/      der fertige Produktions-Stand (jederzeit neu erzeugbar)
```

## Warum zwei Ports

| Port | Was |
|------|-----|
| 4400 | Oberfläche und Schnittstelle |
| 4401 | Vorschau der Kundenwebsite |

Ein Browser behandelt zwei Ports als zwei verschiedene Herkünfte. Dadurch kann ein
Skript aus einem importierten ZIP niemals an die Daten der Oberfläche – und damit
später auch nicht an die API-Schlüssel. Beide Server hören nur auf `127.0.0.1`,
sind also aus dem Netzwerk nicht erreichbar.

## Was die Vorschau nicht kann

PHP wird nicht ausgeführt. Der Vorschau-Server liefert `.php`-Dateien bewusst gar
nicht aus – in `config.php` stehen Zugangsdaten. Auf dem echten Server funktioniert
PHP normal.

## API-Schlüssel

Über das Zahnrad rechts oben im Chat. Die Schlüssel landen in `~/.vinweb/keys.json`
(nur für dich lesbar) — nicht im Projektordner und nicht im Repo. Deshalb kannst du
VinWeb weitergeben, ohne dass deine Schlüssel mitgehen.

Der Browser bekommt die Schlüssel nie zu sehen: alle KI-Aufrufe laufen über den
lokalen Server, die Oberfläche zeigt nur eine maskierte Anzeige.

## Verlauf und Zurücksetzen

Jedes Projekt bekommt beim Import ein eigenes Git-Repo in `source/`. Gesichert wird
automatisch vor und nach jeder VinWeb-Aktion, dazu über den Knopf «Stand jetzt sichern»
mit eigenem Namen. Vor jeder Aktion wird ausserdem festgehalten, was sich seit dem
letzten Mal von aussen geändert hat — Arbeit im Editor oder im eingebauten Bild-Editor
geht also ebenfalls nicht verloren.

Zusätzlich sichert VinWeb alle 5 Minuten automatisch, sobald sich etwas geändert hat –
auch Arbeit von aussen (Editor, Claude Design, Bild-Editor). Den Takt steuert die
Umgebungsvariable `VINWEB_AUTO_SICHERN_SEKUNDEN` (0 schaltet ihn aus).

Im Reiter «Verlauf» siehst du alle Stände nach Tag und Uhrzeit. «Ansehen» zeigt vorher,
was ein Zurücksetzen bewirken würde. Zurücksetzen geht für das ganze Projekt oder für
eine einzelne Datei.

**Zurücksetzen löscht nie etwas.** Der alte Stand wird als neuer Stand obendrauf
geschrieben, die Zwischenstände bleiben in der Liste. Auch das Zurücksetzen ist damit
umkehrbar.

Was versioniert wird, steuern die Häkchen bei «Repo» im Reiter «Was gehört wohin».
Das Häkchen bedeutet damit wörtlich: gesichert und wiederherstellbar.

## KI-Chat: automatisches Nachreichen

Fehlt der KI eine Datei, fordert sie sie über eine Protokollzeile an; VinWeb prüft
den Pfad, liefert den Inhalt nach und lässt die Aufgabe im selben Durchgang lösen
(max. 1 Nachreich-Runde, 6 Dateien à 300 KB). Dateien mit Zugangsdaten werden nie
übergeben — auch nicht auf direkte Anforderung. Die Kostenzeile summiert alle Runden.

## Klick-Editoren in der Vorschau

Die Projekt-eigenen Editoren (Bild anklicken → hochladen; image-slot, media-edit,
scroll-shot) funktionieren in der Quell-Vorschau: VinWeb setzt beim Ausliefern eine
Brücke ein (`window.omelette.writeFile` → `/__vinweb/schreiben`), die ausschliesslich
`.state.json`-Sidecars am Projektstamm schreiben darf und durch die Projekt-
Warteschlange läuft. Der Build entfernt zudem Editor-Reste hinter `</html>`.

NOCH OFFEN: Die Sidecar-Bilder werden beim Build noch nicht in die Seiten
«eingebacken» — per Klick ersetzte Bilder erscheinen darum noch nicht im
Produktions-Stand. Kommt vor dem Deploy.

## Sicherheit (Stand der Prüfung)

- Beide Server hören nur auf `127.0.0.1` – aus dem Netzwerk nicht erreichbar.
- Oberfläche (4400) und Vorschau (4401) sind getrennte Herkünfte: fremdes Skript
  aus einem ZIP kommt nicht an die Schlüssel.
- Der Vorschau-Server dekodiert die Adresse, bevor er sie prüft, und weist `.git`,
  `..` und `.php` ab – auch in Tarnschreibweisen wie `%2E` oder `%2F`.
- Der Import entpackt keinen `.git`-Ordner aus fremden ZIPs, und kein Schreibpfad
  darf in `.git` zeigen. Beides würde sonst Code-Ausführung über Git-Hooks erlauben.
- Jeder Pfad wird gegen Ausbruch aus dem Projektordner geprüft (Zip-Slip-Schutz).
- Schreibvorgänge je Projekt laufen über eine Warteschlange nacheinander –
  die automatische Sicherung kann keinen halben Stand festhalten.
- API-Schlüssel liegen nur in `~/.vinweb/keys.json` (Rechte 600), nie im Browser.

## Produktions-Build (Reiter «Build»)

Ein Klick macht aus dem Rohexport eine hostbare Website in `build/`:

1. Nur Dateien mit Häkchen «Server» wandern mit; Dateien mit Zugangsdaten nie.
2. Fremd eingebundene Bilder (z. B. Tilda-CDN) werden heruntergeladen und unter
   `assets/extern/` lokal eingebunden. Karten- und Video-iframes bleiben stehen
   und werden als Hinweis gemeldet.
3. Bilder über 250 KB werden neu komprimiert (max. 2000 px Breite); geschrieben
   wird nur, wenn es wirklich kleiner wird.
4. Dateinamen werden kleingeschrieben und von Sonderzeichen befreit; alle
   internen Links werden mitgezogen.

Die Quelle bleibt unberührt. In der Vorschau schaltet «Quelle | Build» zwischen
beiden Ständen um; der Build läuft unter `/<projekt>/__build__/…`.

## Inhalte ernten (Seitenleiste links)

Adresse einer bestehenden Website eintragen, «Ernten» klicken. VinWeb sammelt die
Texte aller Unterseiten (als Markdown) und lädt alle Bilder in Originalqualität —
als Rohstoff für den Neubau, nicht als lauffähige Kopie. Ergebnis in `ernte/<domain>-<datum>/`:
`inhalte.md` (alles in einem), `seiten/` (pro Seite), `bilder/` (Fotos, Screenshots),
`bilder-klein/` (Logos, Icons), `galerie.html` (Übersicht zum Aussortieren), `bericht.json`.

Bilder werden dreistufig behandelt: Schrott (Zählpixel, Winzbilder unter 80 px,
Duplikate) wird gar nicht gespeichert; der Rest wird nach Grösse in Inhalt und
Kleinkram sortiert (Schwellen: 300×200 px oder 60 KB — einstellbar oben in
`lib/ernte.js`); die endgültige Auswahl triffst du per Blick in `galerie.html`
und löschst Unerwünschtes im Finder.

Anstand ist eingebaut: robots.txt wird beachtet, eine Anfrage nach der anderen mit
Pause, nur die angegebene Domain, Obergrenzen für Seitenzahl und Bildgrösse.
Nur für eigene Projekte und Kundenaufträge verwenden.

## SEO (Reiter «SEO»)

Site-Profil, Titel/Beschreibung je Seite (mit Zeichenzähler und Richtwerten),
Auffindbar-Schalter (noindex) und 301-Weiterleitungen. Bestehende
`sitesett-config.json` lässt sich übernehmen — ein darin gespeicherter API-Schlüssel
wird dabei verworfen. «KI: fehlende Titel & Beschreibungen» füllt leere Felder mit
Vorschlägen, die NUR in der Tabelle landen; geschrieben wird erst beim Build.

Der Build reichert damit jeden <head> an (Title, Description, Canonical, Open Graph,
JSON-LD) und erzeugt sitemap.xml, robots.txt, 404.html, .htaccess (Redirects +
Sicherheits-Kopfzeilen) und llms.txt. Alles nur im Build, nie in der Quelle, und
wiederholbar (markierter Block wird ersetzt, nie dupliziert).

## Nächste Etappen

6. Deploy auf Cyon (Staging → Live), Reservestand auf Hostpoint
Später: Englisch als zweite Sprache (/en/ + hreflang), Click-to-Edit
