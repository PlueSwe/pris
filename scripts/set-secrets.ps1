# Kopierar FTP-uppgifterna fran .env till GitHub Secrets/Variables
# for repot PlueSwe/pris. Kors av DIG i PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\set-secrets.ps1
# Innehaller inga hemligheter - vardena lases ur din lokala .env.

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Test-Path ".env")) {
    Write-Host "FEL: .env saknas. Fyll i .env forst (se mallen)."
    exit 1
}

# Las .env och satt som miljovariabler
Get-Content ".env" | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$' -and $_ -notmatch '^\s*#') {
        Set-Item -Path ("Env:" + $Matches[1]) -Value $Matches[2]
    }
}

foreach ($k in @("FTP_SERVER", "FTP_USERNAME", "FTP_PASSWORD")) {
    $item = Get-Item -Path ("Env:" + $k) -ErrorAction SilentlyContinue
    if ($null -eq $item -or [string]::IsNullOrWhiteSpace($item.Value)) {
        Write-Host ("FEL: " + $k + " ar tomt i .env")
        exit 1
    }
}

$repo = "PlueSwe/pris"

Write-Host "Lagger in secrets i $repo ..."
gh secret set FTP_SERVER   --repo $repo --body $env:FTP_SERVER
gh secret set FTP_USERNAME --repo $repo --body $env:FTP_USERNAME
gh secret set FTP_PASSWORD --repo $repo --body $env:FTP_PASSWORD

if ([string]::IsNullOrWhiteSpace($env:FTP_SERVER_DIR)) { $env:FTP_SERVER_DIR = "./" }
if ([string]::IsNullOrWhiteSpace($env:FTP_PROTOCOL))   { $env:FTP_PROTOCOL = "ftps" }

Write-Host "Lagger in variabler (ej hemliga) ..."
gh variable set FTP_SERVER_DIR --repo $repo --body $env:FTP_SERVER_DIR
gh variable set FTP_PROTOCOL   --repo $repo --body $env:FTP_PROTOCOL

Write-Host ""
Write-Host "Verifiering (namn, inte varden):"
gh secret list --repo $repo
gh variable list --repo $repo
Write-Host ""
Write-Host "KLART! Sag till Claude att du kort klart, sa triggas deployen."
