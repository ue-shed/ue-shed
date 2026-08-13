param(
	[Parameter(Mandatory = $true)]
	[string]$ProjectRoot,

	[Parameter(Mandatory = $true)]
	[string]$PlanPath,

	[Parameter(Mandatory = $true)]
	[string]$Endpoint,

	[Parameter(Mandatory = $true)]
	[string]$Label,

	[ValidateRange(1, 20)]
	[int]$Runs = 3,

	[ValidateRange(50, 5000)]
	[int]$SampleIntervalMilliseconds = 100,

	[string]$OutputPath
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$resolvedPlanPath = (Resolve-Path -LiteralPath $PlanPath).Path
$plan = Get-Content -LiteralPath $resolvedPlanPath -Raw | ConvertFrom-Json
$planId = $plan.id
$runRoot = Join-Path $resolvedProjectRoot ".ue-shed\map-capture\runs\$planId"
$logicalProcessorCount = [Environment]::ProcessorCount

if (-not $OutputPath) {
	$OutputPath = Join-Path $repositoryRoot "out\benchmarks\map-capture\$Label.json"
}
$resolvedOutputPath = [IO.Path]::GetFullPath($OutputPath, $repositoryRoot)
$outputDirectory = Split-Path -Parent $resolvedOutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$editors = @(Get-Process -Name "UnrealEditor" -ErrorAction SilentlyContinue)
if ($editors.Count -ne 1) {
	throw "Expected exactly one UnrealEditor process, found $($editors.Count)."
}
$editorId = $editors[0].Id

function New-GpuCounters([int]$ProcessId) {
	try {
		$engineCategory = [Diagnostics.PerformanceCounterCategory]::new("GPU Engine")
		$engineCounters = @(
			$engineCategory.GetInstanceNames()
			| Where-Object { $_ -match "^pid_${ProcessId}_" }
			| ForEach-Object {
				[Diagnostics.PerformanceCounter]::new(
					"GPU Engine",
					"Utilization Percentage",
					$_,
					$true
				)
			}
		)
		$memoryCategory = [Diagnostics.PerformanceCounterCategory]::new("GPU Process Memory")
		$memoryCounters = @(
			$memoryCategory.GetInstanceNames()
			| Where-Object { $_ -match "^pid_${ProcessId}_" }
			| ForEach-Object {
				[Diagnostics.PerformanceCounter]::new(
					"GPU Process Memory",
					"Local Usage",
					$_,
					$true
				)
			}
		)
		foreach ($counter in $engineCounters) { $null = $counter.NextValue() }
		foreach ($counter in $memoryCounters) { $null = $counter.NextValue() }
		return @{ engines = $engineCounters; memory = $memoryCounters }
	} catch {
		return @{ engines = @(); memory = @() }
	}
}

function Get-Percentile([double[]]$Values, [double]$Percentile) {
	if ($Values.Count -eq 0) { return 0.0 }
	$sorted = @($Values | Sort-Object)
	$index = [Math]::Min($sorted.Count - 1, [Math]::Floor($sorted.Count * $Percentile))
	return [double]$sorted[$index]
}

$gpuCounters = New-GpuCounters $editorId
$results = @()
$pnpm = (Get-Command "pnpm.cmd" -ErrorAction Stop).Source

try {
	for ($runIndex = 1; $runIndex -le $Runs; $runIndex += 1) {
		$stdoutPath = Join-Path $outputDirectory "$Label-$runIndex.stdout.log"
		$stderrPath = Join-Path $outputDirectory "$Label-$runIndex.stderr.log"
		$startedAt = Get-Date
		$editor = Get-Process -Id $editorId
		$initialCpuMilliseconds = $editor.TotalProcessorTime.TotalMilliseconds
		$previousCpuMilliseconds = $initialCpuMilliseconds
		$previousSampleAt = $startedAt
		$samples = @()

		$command = Start-Process -FilePath $pnpm -ArgumentList @(
			"ue-shed",
			"map-capture",
			"run",
			$resolvedProjectRoot,
			$resolvedPlanPath,
			$Endpoint
		) -WorkingDirectory $repositoryRoot -NoNewWindow -PassThru `
			-RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

		while (-not $command.HasExited) {
			Start-Sleep -Milliseconds $SampleIntervalMilliseconds
			$sampledAt = Get-Date
			$editor = Get-Process -Id $editorId
			$currentCpuMilliseconds = $editor.TotalProcessorTime.TotalMilliseconds
			$elapsedSampleMilliseconds = ($sampledAt - $previousSampleAt).TotalMilliseconds
			$cpuPercent = if ($elapsedSampleMilliseconds -gt 0) {
				100.0 * ($currentCpuMilliseconds - $previousCpuMilliseconds) `
					/ $elapsedSampleMilliseconds / $logicalProcessorCount
			} else { 0.0 }
			$gpuValues = @(
				$gpuCounters.engines | ForEach-Object {
					try { [double]$_.NextValue() } catch { 0.0 }
				}
			)
			$gpuMemoryBytes = [double](
				$gpuCounters.memory | ForEach-Object {
					try { [double]$_.NextValue() } catch { 0.0 }
				} | Measure-Object -Sum
			).Sum
			$samples += [pscustomobject]@{
				cpuPercent = $cpuPercent
				gpuBusiestEnginePercent = if ($gpuValues.Count -gt 0) {
					[double]($gpuValues | Measure-Object -Maximum).Maximum
				} else { 0.0 }
				gpuLocalMemoryBytes = $gpuMemoryBytes
				privateMemoryBytes = [double]$editor.PrivateMemorySize64
				workingSetBytes = [double]$editor.WorkingSet64
			}
			$previousCpuMilliseconds = $currentCpuMilliseconds
			$previousSampleAt = $sampledAt
		}
		$command.WaitForExit()
		$completedAt = Get-Date
		if ($command.ExitCode -ne 0) {
			$errorText = Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
			throw "Capture run $runIndex failed with exit code $($command.ExitCode): $errorText"
		}

		$manifestPath = Get-ChildItem -LiteralPath $runRoot -Directory
			| Where-Object { $_.LastWriteTime -ge $startedAt.AddSeconds(-1) }
			| Sort-Object LastWriteTime -Descending
			| Select-Object -First 1
		if (-not $manifestPath) { throw "Capture run $runIndex did not publish a manifest." }
		$manifestFile = Join-Path $manifestPath.FullName "manifest.json"
		$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
		$manifestDurationMilliseconds = (
			([datetime]$manifest.completedAt) - ([datetime]$manifest.startedAt)
		).TotalMilliseconds
		$cpuValues = @($samples | ForEach-Object { [double]$_.cpuPercent })
		$gpuValues = @($samples | ForEach-Object { [double]$_.gpuBusiestEnginePercent })
		$workingValues = @($samples | ForEach-Object { [double]$_.workingSetBytes })
		$privateValues = @($samples | ForEach-Object { [double]$_.privateMemoryBytes })
		$gpuMemoryValues = @($samples | ForEach-Object { [double]$_.gpuLocalMemoryBytes })
		$results += [pscustomobject]@{
			run = $runIndex
			runId = $manifest.runId
			wallMilliseconds = ($completedAt - $startedAt).TotalMilliseconds
			manifestMilliseconds = $manifestDurationMilliseconds
			tileCount = @($manifest.tiles).Count
			outputBytes = [double](@($manifest.tiles.bytes) | Measure-Object -Sum).Sum
			sampleCount = $samples.Count
			cpuAveragePercent = [double]($cpuValues | Measure-Object -Average).Average
			cpuPeakPercent = [double]($cpuValues | Measure-Object -Maximum).Maximum
			cpuP95Percent = Get-Percentile $cpuValues 0.95
			workingSetAverageBytes = [double]($workingValues | Measure-Object -Average).Average
			workingSetPeakBytes = [double]($workingValues | Measure-Object -Maximum).Maximum
			privateMemoryAverageBytes = [double]($privateValues | Measure-Object -Average).Average
			privateMemoryPeakBytes = [double]($privateValues | Measure-Object -Maximum).Maximum
			gpuBusiestEngineAveragePercent = [double]($gpuValues | Measure-Object -Average).Average
			gpuBusiestEnginePeakPercent = [double]($gpuValues | Measure-Object -Maximum).Maximum
			gpuLocalMemoryAverageBytes = [double]($gpuMemoryValues | Measure-Object -Average).Average
			gpuLocalMemoryPeakBytes = [double]($gpuMemoryValues | Measure-Object -Maximum).Maximum
		}
		$runMessage = (
			"{0} run {1}: manifest {2:N1} ms, wall {3:N1} ms, CPU avg {4:N1}%, " +
			"GPU avg {5:N1}%, working-set peak {6:N0} MiB"
		) -f $Label, $runIndex, $manifestDurationMilliseconds,
			($completedAt - $startedAt).TotalMilliseconds,
			$results[-1].cpuAveragePercent,
			$results[-1].gpuBusiestEngineAveragePercent,
			($results[-1].workingSetPeakBytes / 1MB)
		Write-Host $runMessage
	}
} finally {
	foreach ($counter in @($gpuCounters.engines) + @($gpuCounters.memory)) {
		$counter.Dispose()
	}
}

$manifestDurations = @($results | ForEach-Object { [double]$_.manifestMilliseconds })
$wallDurations = @($results | ForEach-Object { [double]$_.wallMilliseconds })
$report = [ordered]@{
	schemaVersion = 1
	label = $Label
	capturedAt = (Get-Date).ToUniversalTime().ToString("o")
	inputs = [ordered]@{
		projectRoot = $resolvedProjectRoot
		planPath = $resolvedPlanPath
		endpoint = $Endpoint
		planId = $planId
		tilePixelSize = $plan.tilePixelSize
		levelCount = $plan.levels.count
		coarsestUnitsPerPixel = $plan.levels.coarsestUnitsPerPixel
		sampleIntervalMilliseconds = $SampleIntervalMilliseconds
	}
	process = [ordered]@{
		name = "UnrealEditor"
		id = $editorId
		logicalProcessorCount = $logicalProcessorCount
	}
	summary = [ordered]@{
		manifestMedianMilliseconds = Get-Percentile $manifestDurations 0.5
		wallMedianMilliseconds = Get-Percentile $wallDurations 0.5
		cpuAveragePercent = [double](@($results.cpuAveragePercent) | Measure-Object -Average).Average
		cpuPeakPercent = [double](@($results.cpuPeakPercent) | Measure-Object -Maximum).Maximum
		workingSetPeakBytes = [double](@($results.workingSetPeakBytes) | Measure-Object -Maximum).Maximum
		privateMemoryPeakBytes = [double](@($results.privateMemoryPeakBytes) | Measure-Object -Maximum).Maximum
		gpuBusiestEngineAveragePercent = [double](
			@($results.gpuBusiestEngineAveragePercent) | Measure-Object -Average
		).Average
		gpuBusiestEnginePeakPercent = [double](
			@($results.gpuBusiestEnginePeakPercent) | Measure-Object -Maximum
		).Maximum
		gpuLocalMemoryPeakBytes = [double](
			@($results.gpuLocalMemoryPeakBytes) | Measure-Object -Maximum
		).Maximum
	}
	runs = $results
}

$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedOutputPath -Encoding utf8
Write-Host "Wrote $resolvedOutputPath"
