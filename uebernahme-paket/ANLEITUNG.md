# Übernahme-Paket für den Neuimport von New Vincent
Stand: 05.09.2026 · Quelle: Projekt new-vincent-3 (VinWeb-Verlauf)

Retos Entscheid: Vom alten Projekt überleben NUR diese Anpassungen.
Alles andere (Corinne-Seite, Mini-Testseiten und -Edits, Kontakt-Meta) bewusst NICHT übernehmen.

## 1. Logo / Wortmarke  →  1-logo-swiss-css.patch  +  3-brand-markup.html
- assets/swiss.css: .brand ohne uppercase, "Vincent" Gewicht 700,
  "&Partner" Gewicht 400, halb so gross, LINKSBÜNDIG darunter (align-self: flex-start).
- In allen Seiten das brand-Markup durch die Zeile aus 3-brand-markup.html ersetzen
  (die alten Inline-Styles im <b> entfallen dadurch).

## 2. Blitz-Fix  →  2-blitzfix-head-snippet.html
Die zwei Zeilen DIREKT nach <head…> in JEDE Seite einsetzen (vor allen Stylesheets).
Setzt den Farbmodus aus localStorage (vp_tweaks_v1, Standard Dunkel), bevor der
Browser zeichnet – behebt das weisse Aufblitzen beim Seitenwechsel.
Idempotent einsetzen: nur wenn "vp_tweaks_v1" noch nicht im <head> vorkommt.

## 3. Fallende Schrift Mobile  →  4-falling-letters-mobile.js
Datei ersetzt assets/falling-letters-mobile.js komplett
(Skalierung 0.72 statt 0.8 = 10 % kleiner, Gewicht 800 statt 900).

## NICHT im Paket, aber offen (im neuen Projekt erledigen)
- PHP-Härtung kalender/: wurde im alten Projekt NIE übernommen (Verlauf: kalender/
  seit Import unverändert). Im neuen Projekt via Endprüfung → «In den Chat übernehmen».
