// Direct fetch to an absolute external URL is blocked by the sandbox CSP
// (connect-src 'self'). This needs window.eternal.fetch + network.outbound.
fetch('https://api.example.com/headlines')
  .then((response) => response.json())
  .then((data) => {
    document.getElementById('out').textContent = data.headline;
  })
  .catch(() => {});
