// Das EINE Muster für Dateinamen, die Zugangsdaten tragen können.
//
// Vorher stand fast dasselbe Muster an drei Orten (Analyse, Server-Kontext,
// SEO) – wer dort eine Lücke flickte, vergass leicht die anderen. Jetzt gibt
// es genau eine Quelle, und alle importieren von hier.

export const GEHEIM_DATEINAME = /(^|[/\\])(config\.php|.*-config\.php|\.env(\..*)?|.*credentials.*|.*secret.*|.*token.*\.json|id_rsa|id_ed25519)$/i
