// Der Weg zum Go-Live: neun Schritte, von Import bis Livegang.
//
// Drei Sorten Schritte:
//   auto     – Sitepilot misst selbst (Import da? Kritische Befunde? Build aktuell?)
//   manuell  – Ermessensfragen, die nur ein Mensch beurteilen kann
//              ("Inhalte fertig?"). Der Haken wird in projekt.json gemerkt.
//   golive   – der Livegang selbst; sein Haken kommt NUR vom Deploy-Endpunkt.
//
// "Ready to Live" = Schritte 1-8 grün. Die Abnahme (Schritt 8) friert den
// Quell-Stand ein (projekt.abnahme): ändert sich danach noch etwas, fällt
// der Haken automatisch, bis neu abgenommen ist.

import { verlauf, istRepo } from './git.js'
import { buildPfad } from './build.js'
import { buildFingerabdruck } from './endpruefung.js'

export const SCHRITTE = [
  {
    id: 'import', nr: 1, art: 'auto', ziel: 'import',
    titel: 'Projekt importiert',
    text: 'Das ZIP ist eingelesen und geprüft.',
  },
  {
    id: 'befunde', nr: 2, art: 'auto', ziel: 'befunde',
    titel: 'Kritische Befunde bereinigt',
    text: 'Keine roten Punkte mehr in der Prüfung – Gelbes darf bleiben, Rotes nicht.',
  },
  {
    id: 'dateien', nr: 3, art: 'manuell', ziel: 'struktur',
    titel: 'Dateien zugeordnet',
    text: 'Du hast geprüft, was ins Repo und was auf den Server gehört.',
  },
  {
    id: 'inhalte', nr: 4, art: 'manuell', ziel: 'vorschau',
    titel: 'Inhalte fertig',
    text: 'Texte und Bilder sind vollständig und stimmen – dein Urteil, kein Messwert.',
  },
  {
    id: 'seo', nr: 5, art: 'auto', ziel: 'seo',
    titel: 'SEO vollständig',
    text: 'Domain gesetzt, jede auffindbare Seite hat Titel und Beschreibung.',
  },
  {
    id: 'build', nr: 6, art: 'auto', ziel: 'build',
    titel: 'Build aktuell',
    text: 'Der Produktions-Build existiert und ist neuer als die letzte Änderung.',
  },
  {
    id: 'endpruefung', nr: 7, art: 'auto', ziel: 'endpruefung',
    titel: 'KI-Endprüfung bestanden',
    text: 'Das gewählte Modell hat Code, Sicherheit und SEO geprüft – ohne kritische Funde, auf dem aktuellen Stand.',
  },
  {
    id: 'staging', nr: 8, art: 'manuell', ziel: 'build',
    titel: 'Testserver geprüft',
    text: 'Dein letztes Wort vor dem Livegang: Du hast den fertigen Stand angesehen und für gut befunden.',
  },
  {
    id: 'golive', nr: 9, art: 'golive', ziel: 'start',
    titel: 'Go-Live',
    text: 'Der Livegang selbst – stellt den abgenommenen Stand unverändert auf die Live-Adresse.',
  },
]

export async function fortschrittBerechnen (projekt) {
  const manuell = projekt.fortschritt || {}
  const ergebnis = []

  // Messwerte einsammeln
  const befunde = projekt.analyse?.befunde || []
  const kritisch = befunde.filter(b => b.stufe === 'fehler').length

  const seo = projekt.seo
  const seiten = Object.entries(seo?.pages || {}).filter(([, p]) => p.indexierbar !== false)
  const ohneTitel = seiten.filter(([, p]) => !p.titel).length
  const ohneBeschreibung = seiten.filter(([, p]) => !p.beschreibung).length
  const seoFertig = Boolean(seo?.site?.domain) && seiten.length > 0
    && ohneTitel === 0 && ohneBeschreibung === 0

  // Aktuellen Verlaufs-Stand einmal holen – Build- und Prüfschritt brauchen ihn.
  let letzteAenderung = null
  let aktuellerHash = null
  try {
    if (await istRepo(projekt.id)) {
      const staende = await verlauf(projekt.id)
      letzteAenderung = staende[0]?.datum || null
      aktuellerHash = staende[0]?.hash || null
    }
  } catch { /* ohne Verlauf keine Zeitvergleiche */ }

  // Build aktuell? Vergleich: Zeit des letzten Builds vs. letzter Stand im Verlauf.
  let buildFertig = false
  let buildText = 'Noch kein Build erzeugt.'
  if (projekt.letzterBuild) {
    if (letzteAenderung && new Date(letzteAenderung) > new Date(projekt.letzterBuild)) {
      buildText = 'Build vorhanden, aber die Quelle hat sich seither geändert – neu bauen.'
    } else {
      buildFertig = true
      buildText = 'Build vom ' + new Date(projekt.letzterBuild).toLocaleString('de-CH') + '.'
    }
  }

  for (const s of SCHRITTE) {
    let fertig = false
    let detail = ''

    if (s.id === 'import') {
      fertig = true
      detail = (projekt.analyse?.summe?.dateien || 0) + ' Dateien im Projekt.'
    } else if (s.id === 'befunde') {
      fertig = kritisch === 0
      detail = kritisch === 0
        ? 'Keine kritischen Punkte offen.'
        : kritisch + ' kritische(r) Punkt(e) offen.'
    } else if (s.id === 'seo') {
      fertig = seoFertig
      detail = !seo?.site?.domain
        ? 'Domain fehlt im Site-Profil.'
        : seiten.length === 0
          ? 'Noch keine Seiten im SEO-Reiter.'
          : (ohneTitel + ohneBeschreibung) === 0
            ? seiten.length + ' Seiten vollständig gepflegt.'
            : `${ohneTitel} ohne Titel, ${ohneBeschreibung} ohne Beschreibung.`
    } else if (s.id === 'build') {
      fertig = buildFertig
      detail = buildText
    } else if (s.id === 'endpruefung') {
      const kp = projekt.kiPruefung
      // Review-Fund 18: Verglichen wird der Fingerabdruck des GEPRÜFTEN
      // Builds mit dem aktuellen Build – nicht der Git-Hash der Quelle.
      let abdruckJetzt = null
      try { abdruckJetzt = await buildFingerabdruck(buildPfad(projekt.id)) } catch { /* kein Build */ }
      if (!kp) {
        detail = 'Noch nicht geprüft.'
      } else if (kp.unvollstaendig) {
        detail = 'Letzte Prüfung war unvollständig (KI-Antwort unbrauchbar) – bitte neu prüfen.'
      } else if (kp.buildAbdruck && abdruckJetzt && kp.buildAbdruck !== abdruckJetzt
        // Ausnahme: Der Livegang entfernt nur den Staging-Schutz aus dem
        // geprüften Build – das ist KEINE inhaltliche Änderung. Er merkt sich
        // beide Abdrücke (vorher/nachher), damit die Prüfung gültig bleibt.
        && !(projekt.liveGang && kp.buildAbdruck === projekt.liveGang.gepruefterAbdruck
          && abdruckJetzt === projekt.liveGang.buildAbdruck)) {
        detail = 'Der Build hat sich seit der Prüfung geändert – bitte neu prüfen.'
      } else if (!kp.buildAbdruck && aktuellerHash && kp.stand && kp.stand !== aktuellerHash) {
        detail = 'Der Stand hat sich seit der Prüfung geändert – bitte neu prüfen.'
      } else if (kp.statistik.kritisch > 0) {
        detail = `Prüfung vom ${new Date(kp.am).toLocaleDateString('de-CH')}: ${kp.statistik.kritisch} kritische(r) Fund(e) offen.`
      } else {
        fertig = true
        detail = `Bestanden (${new Date(kp.am).toLocaleDateString('de-CH')}, ${kp.modell}): `
          + `${kp.statistik.warnung} Warnung(en), ${kp.statistik.hinweis} Hinweis(e).`
      }
    } else if (s.id === 'staging' && s.art === 'manuell') {
      // Die Abnahme friert den Quell-Stand ein: ändert sich danach noch
      // etwas, verfällt der Haken, bis neu geprüft und abgehakt ist.
      fertig = Boolean(manuell.staging)
      if (!fertig) {
        detail = 'Wartet auf deine Bestätigung.'
      } else if (projekt.abnahme?.stand && aktuellerHash && projekt.abnahme.stand !== aktuellerHash) {
        fertig = false
        detail = 'Seit deiner Abnahme hat sich die Quelle geändert – neu auf den Testserver stellen, prüfen und erneut abhaken.'
      } else {
        detail = projekt.abnahme?.am
          ? 'Von dir abgenommen am ' + new Date(projekt.abnahme.am).toLocaleString('de-CH') + '.'
          : 'Von dir als fertig bestätigt.'
      }
    } else if (s.art === 'manuell') {
      fertig = Boolean(manuell[s.id])
      detail = fertig ? 'Von dir als fertig bestätigt.' : 'Wartet auf deine Bestätigung.'
    } else if (s.id === 'golive') {
      const bereitBisher = ergebnis.every(v => v.fertig)
      const zielDa = Boolean(projekt.deploy?.host && projekt.deploy?.live)
      fertig = Boolean(manuell.golive)
      if (fertig) {
        detail = 'Live' + (projekt.liveGang?.am
          ? ' seit ' + new Date(projekt.liveGang.am).toLocaleString('de-CH') : '!')
          + (projekt.liveGang?.url ? ' – ' + projekt.liveGang.url : '')
        if (projekt.liveGang?.stand && aktuellerHash && projekt.liveGang.stand !== aktuellerHash) {
          detail += '. Seither gab es Änderungen – für eine neue Fassung den Weg erneut durchlaufen und wieder live stellen.'
        }
      } else if (bereitBisher && zielDa) {
        detail = 'Bereit – oben wartet der Knopf «Jetzt live schalten».'
      } else if (bereitBisher) {
        detail = 'Bereit – zuerst das Live-Ziel eintragen (Reiter Build → «Ziel ändern»).'
      } else {
        detail = 'Wird frei, sobald die Schritte 1–8 grün sind.'
      }
    }

    ergebnis.push({ ...s, fertig, detail })
  }

  const vorstufen = ergebnis.filter(s => s.id !== 'golive')
  return {
    schritte: ergebnis,
    fertigZahl: ergebnis.filter(s => s.fertig).length,
    gesamt: ergebnis.length,
    bereit: vorstufen.every(s => s.fertig),   // "Ready to Live"
    live: Boolean(manuell.golive),
    liveZiel: Boolean(projekt.deploy?.host && projekt.deploy?.live),
    liveUrl: projekt.deploy?.liveUrl || projekt.liveGang?.url || '',
    liveAm: projekt.liveGang?.am || null,
  }
}
