/** 初始化页面交互，仅处理弹窗和密码可见性，权限由服务端决定。 */
function initializePage() {
  document.querySelectorAll('[data-open-dialog]').forEach(button => {
    button.addEventListener('click', () => document.getElementById(button.dataset.openDialog).showModal());
  });
  document.querySelectorAll('[data-close-dialog]').forEach(button => {
    button.addEventListener('click', () => button.closest('dialog').close());
  });
  document.querySelectorAll('[data-password-url]').forEach(button => {
    button.addEventListener('click', () => {
      const form = document.getElementById('password-form');
      form.reset();
      form.action = button.dataset.passwordUrl;
      document.getElementById('password-target').textContent = '修改账号 ' + button.dataset.username + ' 的登录密码';
      document.getElementById('password-dialog').showModal();
    });
  });
  document.querySelectorAll('[data-delete-path]').forEach(button => {
    button.addEventListener('click', () => {
      const form = document.getElementById('delete-form');
      form.reset();
      form.elements.path.value = button.dataset.deletePath;
      document.getElementById('delete-target').textContent = button.dataset.deletePath;
      document.getElementById('delete-description').textContent = button.dataset.deleteDirectory === 'true'
        ? '将永久删除此文件夹及其中的所有文件和子文件夹。若该项为链接，仅删除链接本身。'
        : '将永久删除此文件。若该项为链接，仅删除链接本身。';
      document.getElementById('delete-dialog').showModal();
    });
  });
  document.querySelectorAll('[data-toggle-password]').forEach(button => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.togglePassword);
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(visible));
      button.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
    });
  });
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('close', () => dialog.querySelector('form')?.reset());
  });
}

initializePage();
