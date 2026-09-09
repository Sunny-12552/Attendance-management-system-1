$portProcess = netstat -ano | Select-String ':3000' | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1
if ($portProcess) { taskkill /F /PID $portProcess }
npm start
