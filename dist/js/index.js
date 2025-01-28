const socket = io();

$(document).ready(function() {
  // Handle tambah session
  $('#addSessionForm').submit(function(e) {
    e.preventDefault();
    const sessionId = $('#sessionId').val();
    
    $.post('/api/sessions', { sessionId })
      .done(() => {
        addSessionRow(sessionId);
        $('#sessionId').val('');
      })
      .fail(err => showError(err.responseJSON.error));
  });

  // Handle modal
  $('.close').click(() => $('#qrModal').hide());
  $(window).click(e => {
    if (e.target.id === 'qrModal') $('#qrModal').hide();
  });
});

function addSessionRow(sessionId) {
  const row = `
    <tr data-session="${sessionId}">
      <td>${sessionId}</td>
      <td class="phone">-</td>
      <td class="name">-</td>
      <td><span class="status">❌ Disconnected</span></td>
      <td>
        <button class="connect">Connect</button>
        <button class="disconnect" style="display:none;">Disconnect</button>
      </td>
    </tr>
  `;
  $('#sessions tbody').append(row);
}

// Handle session events
$(document)
  .on('click', '.connect', function() {
    const sessionId = $(this).closest('tr').data('session');
    socket.emit('joinSession', sessionId);
    showQrModal(sessionId);
  })
  .on('click', '.disconnect', function() {
    const sessionId = $(this).closest('tr').data('session');
    socket.emit('disconnectSession', sessionId);
  });

socket
  .on('qr', ({ sessionId, url }) => {
    $('#modalSessionName').text(sessionId);
    $('#qrImage').attr('src', url);
    $('#qrModal').show();
  })
  .on('ready', ({ sessionId, phoneNumber, pushname }) => {
    const row = $(`tr[data-session="${sessionId}"]`);
    row.find('.phone').text(phoneNumber);
    row.find('.name').text(pushname);
    row.find('.status').html('✅ Connected');
    row.find('.connect').hide();
    row.find('.disconnect').show();
    $('#qrModal').hide();
  })
  .on('disconnected', ({ sessionId }) => {
    const row = $(`tr[data-session="${sessionId}"]`);
    row.find('.status').html('❌ Disconnected');
    row.find('.connect').show();
    row.find('.disconnect').hide();
  });

function showQrModal(sessionId) {
  $('#modalSessionName').text(sessionId);
  $('#qrModal').show();
}

function showError(message) {
  alert(`Error: ${message}`);
}