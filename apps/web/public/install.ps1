# Installs and starts shoal with Docker, in a `shoal` folder in the
# current directory. In PowerShell:
#
#   irm https://shoal.school/install.ps1 | iex
#
# Safe to run again: an existing compose.yml and .env are kept, so the secret
# that signs people in never changes under an installation.
#
# Errors are thrown rather than exiting, because `exit` in a script run by
# `iex` closes the reader's PowerShell window.

& {
	$ErrorActionPreference = "Stop"
	$ProgressPreference = "SilentlyContinue"

	$composeUrl = "https://shoal.school/compose.yml"
	$installDir = "shoal"
	$appUrl = "http://localhost:3000"
	$healthUrl = "$appUrl/api/healthz"
	# How long to wait for the first start, which downloads images and migrates the database.
	$startupTimeoutSeconds = 120

	# 32 random bytes, base64-encoded, as `openssl rand -base64 32` prints them.
	function New-RandomKey {
		$bytes = New-Object byte[] 32
		[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
		[Convert]::ToBase64String($bytes)
	}

	if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
		throw "Docker is required. Install Docker Desktop from https://docs.docker.com/get-docker/"
	}
	# Windows PowerShell 5.1 turns a redirected native command's stderr into a terminating error; the exit code says enough.
	try { docker compose version *> $null } catch {}
	if ($LASTEXITCODE -ne 0) {
		throw "Docker Compose is required. It comes with Docker Desktop: https://docs.docker.com/get-docker/"
	}

	New-Item -ItemType Directory -Force -Path $installDir | Out-Null
	Push-Location $installDir
	try {
		if (Test-Path compose.yml) {
			Write-Host "Keeping the existing $installDir\compose.yml"
		} else {
			Invoke-WebRequest -UseBasicParsing -Uri $composeUrl -OutFile compose.yml
		}

		if (Test-Path .env) {
			Write-Host "Keeping the existing $installDir\.env"
		} else {
			$envFile = "BETTER_AUTH_SECRET=$(New-RandomKey)`n" +
				"# Where your browser and workers reach shoal. Change it to this machine's`n" +
				"# network address (e.g. http://192.168.1.10:3000) for workers on other machines.`n" +
				"SHOAL_URL=$appUrl`n"
			# Without a byte-order mark, which Windows PowerShell's own encoders add and Compose reads as part of the first name.
			[System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), $envFile, (New-Object System.Text.UTF8Encoding $false))
			Write-Host "Wrote $installDir\.env with a new secret. Back it up and keep it private."
		}

		docker compose up -d
		if ($LASTEXITCODE -ne 0) {
			throw "Docker Compose couldn't start shoal. Is Docker Desktop running?"
		}

		Write-Host -NoNewline "Waiting for shoal to start"
		$deadline = (Get-Date).AddSeconds($startupTimeoutSeconds)
		while ($true) {
			try {
				Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 5 | Out-Null
				break
			} catch {
				if ((Get-Date) -ge $deadline) {
					Write-Host ""
					throw "shoal didn't start in time. See what it printed with: cd $installDir; docker compose logs shoal"
				}
				Write-Host -NoNewline "."
				Start-Sleep -Seconds 2
			}
		}
		Write-Host ""

		Write-Host "shoal is running at $appUrl"
		Write-Host "Open it and create your account: the first one owns the install."
		Write-Host "Workers on other machines need SHOAL_URL in $installDir\.env set to this machine's"
		Write-Host "network address. Change it, then run: cd $installDir; docker compose up -d"
	} finally {
		Pop-Location
	}
}
