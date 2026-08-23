const videos = Array.from(document.querySelectorAll('video'));

if (videos.length > 0) {
  const button = document.createElement('button');
  button.textContent = 'Enable Caption AI';
  button.type = 'button';
  Object.assign(button.style, {
    position: 'fixed',
    top: '16px',
    right: '16px',
    zIndex: '2147483647',
    padding: '8px 12px',
    background: '#172554',
    color: '#fff',
    border: '1px solid #60a5fa',
    borderRadius: '6px',
    cursor: 'pointer',
  });
  button.addEventListener('click', () => {
    button.textContent = 'Click Caption AI in toolbar';
  });
  document.documentElement.append(button);
}
