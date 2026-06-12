Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$prefix = "http://127.0.0.1:8124/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

function Write-CorsHeaders($response) {
  $response.Headers.Set("Access-Control-Allow-Origin", "*")
  $response.Headers.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
  $response.Headers.Set("Access-Control-Allow-Headers", "Content-Type")
  $response.Headers.Set("Cache-Control", "no-store")
}

try {
  $listener.Start()
  Write-Output "Infinite Paper clipboard bridge listening on $prefix"

  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    Write-CorsHeaders $response

    try {
      if ($request.HttpMethod -eq "OPTIONS") {
        $response.StatusCode = 204
        continue
      }

      if ($request.Url.AbsolutePath -ne "/clipboard-image") {
        $response.StatusCode = 404
        continue
      }

      if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) {
        $response.StatusCode = 204
        continue
      }

      $image = [System.Windows.Forms.Clipboard]::GetImage()
      if ($null -eq $image) {
        $response.StatusCode = 204
        continue
      }

      $stream = [System.IO.MemoryStream]::new()
      try {
        $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $stream.ToArray()
      } finally {
        $stream.Dispose()
        $image.Dispose()
      }

      $response.StatusCode = 200
      $response.ContentType = "image/png"
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      $response.StatusCode = 500
    } finally {
      $response.OutputStream.Close()
    }
  }
} finally {
  if ($listener.IsListening) {
    $listener.Stop()
  }
  $listener.Close()
}
