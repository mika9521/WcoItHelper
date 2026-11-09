# AD Portal (Node.js)

Modularny portal do zarządzania AD pod środowisko szpitalne:

- logowanie po poświadczeniach AD,
- autoryzacja po konkretnych użytkownikach lub grupie AD,
- wyszukiwarka obiektów (użytkownicy/komputery/grupy),
- osobne modale dla różnych typów obiektów,
- zarządzanie `memberOf` (dodawanie grup, kopiowanie zaznaczonych grup od użytkownika referencyjnego),
- zarządzanie członkami grupy (dodawanie/usuwanie kont bezpośrednio z poziomu obiektu grupy),
- przenoszenie obiektu do OU,
- kreator nowego użytkownika,
- podgląd i eksport (PDF / schowek) kluczy odzyskiwania BitLocker dla komputerów,
- odblokowywanie kont przeniesionych do OU zablokowane_konta (z wyborem docelowego OU),
- zakładka raportów (np. logowania starsze niż X lat),
- szczegółowe logi zmian (kto, co i jakie wartości zmienił),
- ustawienia portalu: domyślna grupa dla nowych kont, kategorie uprawnień (zestawy grup do szybkiego zastosowania),
- integracja z SCCM (wyszukiwanie/podgląd urządzeń, kolumna "Komputer" przy użytkownikach) – patrz sekcja SCCM poniżej,
- toasty i modale w UI,
- **działanie offline UI** z pełnym Bootstrapem dostarczonym lokalnie z `node_modules/bootstrap/dist` (bez CDN).

## Uruchomienie

1. Skopiuj konfigurację:

```bash
cp .env.example .env
```

2. Uzupełnij dane AD w `.env`.
3. Zainstaluj zależności i uruchom:

```bash
npm install
npm run dev
```

## Architektura modułowa

- `src/services/ad/*` – integracja i operacje AD,
- `src/services/reports/*` – raporty,
- `src/routes/*` – warstwa API i widoki,
- `src/middleware/*` – middleware (np. auth),
- `src/views/*` i `src/public/*` – UI (EJS + JS aplikacyjny),
- `/bootstrap/*` – statyczny mount do `node_modules/bootstrap/dist` (offline, lokalne pliki).

## Ważne dla AD

- Do ustawiania haseł i modyfikacji kont używaj `LDAPS`.
- Konto serwisowe powinno mieć tylko minimalne wymagane uprawnienia.
- W produkcji ustaw `AD_TLS_REJECT_UNAUTHORIZED=true` i poprawny certyfikat CA.

## LDAP / LDAPS i TLS

Możesz teraz skonfigurować połączenie na dwa sposoby:

1. **Pełny URL** przez `AD_URL` (np. `ldap://dc01.hospital.local:389` albo `ldaps://dc01.hospital.local:636`).
2. **Składany URL** przez:
   - `AD_PROTOCOL=ldap` lub `AD_PROTOCOL=ldaps`,
   - `AD_HOST`,
   - `AD_PORT`.

Dodatkowo:

- `AD_TLS_ENABLED=true|false` – włącza/wyłącza TLS.
  - Dla `ldap://` działa jako **StartTLS**.
  - Dla `ldaps://` szyfrowanie jest zapewniane przez sam protokół.
- `AD_TLS_REJECT_UNAUTHORIZED=true|false` – walidacja certyfikatu TLS.
- `AD_USE_LOGGED_USER_BIND=true|false` – wybór kontekstu uprawnień dla operacji AD:
  - `false` (domyślnie): operacje wykonywane kontem serwisowym (`AD_BIND_DN`),
  - `true`: operacje wykonywane poświadczeniami aktualnie zalogowanego użytkownika.

## SCCM (Microsoft Configuration Manager)

Portal łączy się z **AdminService** Twojej witryny SCCM (REST/OData, dostępny od wersji 1802+, pod
`https://<serwer>/AdminService/wmi`), tym samym kontem AD co LDAP. Są dwa tryby uwierzytelniania
(`SCCM_AUTH_MODE`), bo różne środowiska IIS oferują różne dostawce Windows Authentication:

### Tryb `ntlm` (domyślny)

NTLM wymaga zwykłej nazwy użytkownika i domeny, a nie DN/UPN, dlatego:

- gdy `AD_USE_LOGGED_USER_BIND=true` – używane są login i hasło aktualnie zalogowanego użytkownika
  portalu (login jest już w formacie `sAMAccountName`, więc nic dodatkowego nie trzeba ustawiać),
- gdy `AD_USE_LOGGED_USER_BIND=false` – ustaw `SCCM_SERVICE_USERNAME` na `sAMAccountName` konta
  serwisowego z `AD_BIND_DN` (hasło to nadal `AD_BIND_PASSWORD` – to to samo konto).

Dodatkowa zmienna: `SCCM_DOMAIN` – domena NTLM (NetBIOS lub DNS); domyślnie wyliczana z
`AD_BASE_DN`. Jeśli uwierzytelnianie się nie powiedzie, spróbuj ustawić krótką nazwę NetBIOS.

**Ten tryb działa tylko, jeśli IIS dla AdminService ma włączony dostawca „NTLM” w Windows
Authentication.** Jeśli serwer oferuje wyłącznie „Negotiate” (np. NTLM zablokowany politykami GPO
– częste w środowiskach szpitalnych/regulowanych), użyj trybu `kerberos` poniżej.

### Tryb `kerberos`

Dla serwerów, które akceptują tylko Negotiate/Kerberos. Ten tryb wymaga dodatkowych komponentów
**zainstalowanych na serwerze, na którym działa ten portal** (nie da się tego obejść samym npm):

1. **Pakiet systemowy z `kinit`**: `apt-get install krb5-user` (Debian/Ubuntu) lub
   `yum install krb5-workstation` (RHEL/CentOS). Portal wywołuje `kinit` jako podproces, żeby
   uzyskać bilet Kerberos z hasła konta (GSSAPI na Linuksie nie ma własnego sposobu logowania się
   samym hasłem – potrzebuje gotowego biletu w cache).
2. **Biblioteki krb5 do kompilacji natywnego modułu `kerberos`** (już w `package.json`):
   `apt-get install libkrb5-dev` (Debian/Ubuntu) lub `yum install krb5-devel` (RHEL/CentOS), potem
   `npm install`.
3. **`/etc/krb5.conf`** z poprawnym realm i KDC Twojej domeny. Jeśli DNS ma opublikowane rekordy
   SRV dla Kerberosa (typowe dla AD), często wystarczy:
   ```ini
   [libdefaults]
       default_realm = HOSPITAL.LOCAL
       dns_lookup_kdc = true
       dns_lookup_realm = true
   ```

Zmienne środowiskowe (poza `SCCM_SERVICE_USERNAME`/`AD_USE_LOGGED_USER_BIND`, które działają tak
samo jak w trybie NTLM):

- `SCCM_AUTH_MODE=kerberos`
- `SCCM_KERBEROS_REALM` – realm Kerberos (zwykle domena wielkimi literami, np. `HOSPITAL.LOCAL`).
  Domyślnie wyliczany z `AD_BASE_DN`.
- `SCCM_SPN` – Service Principal Name serwera AdminService, np. `HTTP@sccm01.hospital.local`.
  Domyślnie `HTTP@<host z SCCM_URL>` – ustaw ręcznie, jeśli SCCM nasłuchuje pod inną nazwą niż ta
  w `SCCM_URL` (np. alias DNS), bo SPN musi zgadzać się z tym, co zarejestrowano w AD dla konta
  usługi SCCM (`setspn -L <konto_SCCM>`).

Wspólna: `SCCM_TLS_REJECT_UNAUTHORIZED` – walidacja certyfikatu TLS AdminService (domyślnie `true`).

**Zakres obecnej integracji (pierwszy etap):** wyszukiwanie/lista urządzeń, podgląd szczegółów
(dane z `SMS_R_System`, data ostatniego skanu sprzętowego z `SMS_G_System_WORKSTATION_STATUS`),
link „Pokaż w SCCM" z głównej wyszukiwarki oraz kolumna „Komputer" przy użytkownikach (na
podstawie `SMS_UserMachineRelationship`). Kolekcje, wdrożenia i status aktualizacji są
planowane w kolejnym etapie.

**Uwaga:** ta integracja nie mogła zostać przetestowana na prawdziwej witrynie SCCM ani na
prawdziwym KDC (brak dostępu w środowisku, w którym powstał ten kod). Co zostało faktycznie
zweryfikowane: cała ścieżka HTTP/negocjacji trybu Kerberos (budowa żądań, obsługa wyzwania 401 z
drugim etapem negocjacji, parsowanie odpowiedzi) na lokalnym serwerze symulującym IIS, oraz
czytelność komunikatów błędów dla brakującego `kinit` i nieosiągalnego KDC. Nie zweryfikowano:
rzeczywistej wymiany biletów z prawdziwym KDC/AD. Nazwy klas WMI/OData odpowiadają standardowej,
domyślnej konfiguracji AdminService, ale jeśli Twoja witryna różni się (np. niestandardowe klasy
inwentaryzacji), może być potrzebna korekta w `src/services/sccm/sccmClient.js`.

### Rozwiązywanie problemów

- **„Couldn't find NTLM in the message type2 coming from the server"** (tryb `ntlm`) – portal przy
  błędzie połączenia automatycznie odpytuje serwer SCCM bez logowania, żeby sprawdzić, jakie
  uwierzytelnianie faktycznie oferuje, i dopisuje to do komunikatu błędu. Jeśli serwer oferuje
  tylko „Negotiate" – przełącz się na `SCCM_AUTH_MODE=kerberos` (patrz wyżej) albo włącz dostawcę
  „NTLM" w IIS dla AdminService, jeśli to dopuszczalne w Twojej organizacji.
- **„Polecenie kinit nie jest zainstalowane…"** (tryb `kerberos`) – zainstaluj `krb5-user` /
  `krb5-workstation` na serwerze portalu (patrz wyżej).
- **„Nie udało się uzyskać biletu Kerberos (kinit)…"** – treść błędu to bezpośrednio komunikat
  `kinit`: najczęściej zły realm/KDC nieosiągalny (sprawdź `/etc/krb5.conf` i `SCCM_KERBEROS_REALM`)
  albo złe hasło konta.
- **„SCCM AdminService odrzucił uwierzytelnianie Kerberos (401/403)…”** – bilet się uzyskuje, ale
  serwer go odrzuca: sprawdź `SCCM_SPN` (musi dokładnie odpowiadać temu, co zarejestrowano w AD
  przez `setspn` dla konta usługi SCCM) i czy konto ma uprawnienia do odczytu w SCCM (rola
  „Read-only Analyst" lub wyższa).
- **„SCCM AdminService odrzucił uwierzytelnianie (401/403)"** (tryb `ntlm`) – sprawdź
  `SCCM_SERVICE_USERNAME`/hasło (czy to na pewno `sAMAccountName`, nie DN) i uprawnienia konta.
- **Błąd wskazuje na kod inny niż 401** – prawdopodobnie `SCCM_URL` nie wskazuje bezpośrednio na
  AdminService (np. trafia na stronę logowania albo przekierowanie) – zweryfikuj URL w
  przeglądarce: `https://<serwer>/AdminService/wmi/SMS_R_System` powinno poprosić o
  uwierzytelnienie Windows, a nie zwracać stronę HTML.
