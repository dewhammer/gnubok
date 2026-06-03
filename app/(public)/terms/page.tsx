import type { Metadata } from 'next'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getBranding } from '@/lib/branding/service'

export function generateMetadata(): Metadata {
  return {
    title: `Användarvillkor - ${getBranding().appName}`,
  }
}

export default function TermsPage() {
  const { appName, legalEntity, privacyEmail, supportEmail } = getBranding()

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white py-12 px-4">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Användarvillkor
          </h1>
          <p className="text-muted-foreground">
            Senast uppdaterad: 2026-06-03
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>1. Om tjänsten</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              {appName} tillhandahålls av {legalEntity}. Tjänsten hjälper företagare att hantera
              bokföring, fakturor, banktransaktioner, rapporter och närliggande administrativa
              uppgifter. Genom att skapa konto eller använda tjänsten accepterar du dessa villkor.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Konto och behörighet</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <ul>
              <li>Du ansvarar för att uppgifterna i kontot och företagsprofilen är korrekta.</li>
              <li>Du får bara ansluta bankkonton och hantera företag som du har rätt att företräda.</li>
              <li>Du ansvarar för att skydda inloggningslänkar, sessioner och eventuell behörighet till kontot.</li>
              <li>Om du misstänker obehörig åtkomst ska du kontakta oss utan dröjsmål.</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3. Bankkoppling via PSD2</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Om du ansluter bankkonto via PSD2 används Enable Banking för att initiera samtycke hos
              din bank och hämta kontoinformation, saldon och transaktioner enligt det samtycke du
              ger. Du kan när som helst återkalla bankkopplingen i tjänsten eller hos din bank.
            </p>
            <p>
              {appName} initierar inte betalningar från ditt bankkonto om inte en separat funktion
              uttryckligen aktiveras och godkänns av dig.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>4. Bokföringsansvar</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Tjänsten är ett hjälpmedel för ekonomiadministration. Du ansvarar själv för att din
              bokföring, momsredovisning, deklaration, fakturering och arkivering uppfyller gällande
              lagar och regler. Automatiska förslag, matchningar och kategoriseringar ska kontrolleras
              innan de används som beslutsunderlag eller bokförs.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>5. Tillåten användning</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>Du får inte använda tjänsten för att:</p>
            <ul>
              <li>behandla uppgifter som du saknar rätt att behandla,</li>
              <li>kringgå säkerhetsfunktioner, behörighetskontroller eller tekniska begränsningar,</li>
              <li>försöka få obehörig åtkomst till andra användares data,</li>
              <li>ladda upp skadlig kod eller material som bryter mot lag.</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>6. Tillgänglighet och ändringar</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Vi arbetar för att tjänsten ska vara tillgänglig och stabil, men garanterar inte
              oavbruten drift. Funktioner kan ändras, läggas till eller tas bort när det behövs för
              drift, säkerhet, produktutveckling, lagkrav eller leverantörsändringar.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>7. Personuppgifter</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Hur vi behandlar personuppgifter beskrivs i vår{' '}
              <Link href="/privacy" className="text-primary underline underline-offset-4">
                integritetspolicy
              </Link>
              . Om du använder tjänsten för att behandla personuppgifter för ditt företag gäller
              även vårt{' '}
              <Link href="/dpa" className="text-primary underline underline-offset-4">
                personuppgiftsbiträdesavtal
              </Link>
              .
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>8. Ansvarsbegränsning</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Tjänsten tillhandahålls i befintligt skick. Vi ansvarar inte för indirekta skador,
              utebliven vinst, fel som beror på externa leverantörer, bankernas system eller beslut
              som fattas utan egen kontroll av underlaget. Ingenting i dessa villkor begränsar ansvar
              som inte kan begränsas enligt tvingande lag.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>9. Uppsägning</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Du kan sluta använda tjänsten när som helst. Vissa uppgifter kan behöva bevaras under
              lagstadgad arkiveringstid, till exempel bokföringsmaterial enligt bokföringslagen.
              Kontakta oss om du vill avsluta konto eller begära export av data.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>10. Kontakt</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <ul>
              <li><strong>Företag:</strong> {legalEntity}</li>
              <li><strong>Support:</strong> {supportEmail}</li>
              <li><strong>Integritetsfrågor:</strong> {privacyEmail}</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
