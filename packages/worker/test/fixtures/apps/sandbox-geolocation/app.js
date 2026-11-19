// The served permissions policy denies geolocation to app iframes.
navigator.geolocation.getCurrentPosition(
  (position) => {
    document.getElementById('out').textContent = `${position.coords.latitude}, ${position.coords.longitude}`;
  },
  () => {
    document.getElementById('out').textContent = 'unavailable';
  },
);
