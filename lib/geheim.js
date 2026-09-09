// Zentrale Geheimnisprüfung – EIN Ort für Dateinamen-Muster und
// Inhalts-Muster, genutzt von Analyse, KI-Kontext, Endprüfung und Git.
// (Review-Funde 5 und 6: Prüfungen waren verstreut und lückenhaft.)

export const GEHEIM_DATEINAME =
  /(^|[/\\])(config\.php|.*-config\.php|\.env(\..*)?|.*credentials.*|.*secret.*|.*token.*\.json|id_rsa|id_ed25519)$/i

export const SCHLUESSEL_MUSTER = [
  ['Anthropic-Schlüssel', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-Schlüssel', /sk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ['Google-Schlüssel', /AIza[0-9A-Za-z_-]{35}/],
  ['GitHub-Token', /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}/],
  ['privater Schlüssel', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['apiKey-Feld', /["']api[_-]?key["']\s*[:=]\s*["'][^"']{20,}["']/i],
  ['client_secret', /["']client[_-]?secret["']\s*[:=]\s*["'][^"']{12,}["']/i],
]

// Prüft einen DateiINHALT. Gibt die Art des Fundes zurück oder null.
export function geheimnisImInhalt (inhalt) {
  for (const [art, muster] of SCHLUESSEL_MUSTER) {
    if (muster.test(inhalt)) return art
  }
  return null
}

// Kombiprüfung für die Frage: darf diese Datei zur KI / ins Repo?
export function istGeheim (rel, inhalt) {
  if (GEHEIM_DATEINAME.test(rel)) return 'Dateiname'
  return inhalt != null ? geheimnisImInhalt(inhalt) : null
}
