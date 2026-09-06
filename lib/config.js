// Zentrale Einstellungen von VinWeb.
// Hier stehen die beiden Ports und die wichtigsten Pfade.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hier = path.dirname(fileURLToPath(import.meta.url))

// Das Wurzelverzeichnis der App (ein Ordner über /lib).
export const ROOT = path.resolve(hier, '..')

// Hier liegen alle importierten Projekte.
export const PROJECTS_DIR = path.join(ROOT, 'projects')

// Zwei getrennte Ports - das ist Absicht und kein Zufall:
//
//   4400  Bedienoberflaeche + Schnittstelle (hier laufen später die API-Schlüssel)
//   4401  Vorschau der Kundenwebsite
//
// Weil ein Browser zwei Ports als zwei verschiedene Herkünfte behandelt, kann
// ein Skript aus einem importierten ZIP niemals an die Daten der Oberfläche.
export const UI_PORT = 4400
export const PREVIEW_PORT = 4401

// Nur auf dem eigenen Rechner erreichbar - nicht im Netzwerk.
export const HOST = '127.0.0.1'

// Automatische Sicherung: alle X Sekunden wird je Projekt festgehalten, was
// sich geändert hat (0 = aus). Über die Umgebungsvariable
// VINWEB_AUTO_SICHERN_SEKUNDEN lässt sich das Intervall ändern.
export const AUTO_SICHERN_SEKUNDEN = Number(process.env.VINWEB_AUTO_SICHERN_SEKUNDEN ?? 300)
