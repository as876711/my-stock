param(
    [int]$IntervalSeconds = 60,
    [string]$OutputPath = ".\network-monitor.csv",
    [string[]]$Targets = @("1.1.1.1", "8.8.8.8", "google.com")
)

$ErrorActionPreference = "Continue"

function Get-DefaultGateway {
    $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
        Where-Object { $_.NextHop -and $_.NextHop -ne "0.0.0.0" } |
        Sort-Object RouteMetric, InterfaceMetric |
        Select-Object -First 1

    if ($route) {
        return $route.NextHop
    }

    return $null
}

function Measure-Ping {
    param(
        [string]$Target
    )

    try {
        $result = Test-Connection -ComputerName $Target -Count 1 -ErrorAction Stop
        return [pscustomobject]@{
            Target = $Target
            Status = "OK"
            LatencyMs = [int]$result.ResponseTime
            Error = ""
        }
    }
    catch {
        return [pscustomobject]@{
            Target = $Target
            Status = "FAIL"
            LatencyMs = $null
            Error = $_.Exception.Message
        }
    }
}

$gateway = Get-DefaultGateway
if ($gateway -and ($Targets -notcontains $gateway)) {
    $Targets = @($gateway) + $Targets
}

if (-not (Test-Path $OutputPath)) {
    "Timestamp,Target,Status,LatencyMs,Error" | Out-File -FilePath $OutputPath -Encoding UTF8
}

Write-Host "Network monitor started."
$resolvedOutputPath = Resolve-Path -Path $OutputPath -ErrorAction SilentlyContinue
if ($resolvedOutputPath) {
    Write-Host "Output: $resolvedOutputPath"
}
else {
    Write-Host "Output: $OutputPath"
}
Write-Host "Interval: $IntervalSeconds seconds"
Write-Host "Targets: $($Targets -join ', ')"
Write-Host "Press Ctrl+C to stop."

while ($true) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

    foreach ($target in $Targets) {
        $ping = Measure-Ping -Target $target
        $row = [pscustomobject]@{
            Timestamp = $timestamp
            Target = $ping.Target
            Status = $ping.Status
            LatencyMs = $ping.LatencyMs
            Error = $ping.Error
        }

        $row | Export-Csv -Path $OutputPath -NoTypeInformation -Append -Encoding UTF8

        if ($ping.Status -eq "OK") {
            Write-Host "[$timestamp] $($ping.Target) OK $($ping.LatencyMs) ms"
        }
        else {
            Write-Host "[$timestamp] $($ping.Target) FAIL $($ping.Error)" -ForegroundColor Yellow
        }
    }

    Start-Sleep -Seconds $IntervalSeconds
}
