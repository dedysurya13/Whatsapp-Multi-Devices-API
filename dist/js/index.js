const socket = io();

$(document).ready(function () {
  $.get("/api/sessions")
    .done((sessions) => {
      sessions.forEach((session) => {
        addSessionRow(
          session.sessionId,
          session.phoneNumber,
          session.pushname,
          session.connected
        );

        socket.emit("joinSession", session.sessionId);
      });
    })
    .fail((err) => showError(err.responseJSON.error));

  $("#addSessionForm").submit(function (e) {
    e.preventDefault();
    const sessionId = $("#sessionId").val();

    $.post("/api/sessions", { sessionId })
      .done(() => {
        addSessionRow(sessionId);
        $("#sessionId").val("");
      })
      .fail((err) => showError(err.responseJSON.error));
  });

  $(".close").click(() => $("#qrModal").hide());
  $(window).click((e) => {
    if (e.target.id === "qrModal") $("#qrModal").hide();
  });
});

function addSessionRow(
  sessionId,
  phoneNumber = "-",
  pushname = "-",
  connected = false
) {
  const status = connected ? "✅ Connected" : "❌ Disconnected";
  const connectDisplay = connected ? "none" : "inline-block";
  const disconnectDisplay = connected ? "inline-block" : "none";

  const row = `
    <tr data-session="${sessionId}">
      <td>${sessionId}</td>
      <td class="phone">${phoneNumber}</td>
      <td class="name">${pushname}</td>
      <td><span class="status">${status}</span></td>
      <td>
        <button class="connect" style="display:${connectDisplay};">Connect</button>
        <button class="disconnect" style="display:${disconnectDisplay};">Disconnect</button>
        <button class="delete-session">Hapus</button> </td>
    </tr>
  `;
  $('#sessions tbody').append(row);
}

// Handle session events
$(document)
  .on("click", ".connect", function () {
    const sessionId = $(this).closest("tr").data("session");
    socket.emit("joinSession", sessionId);

    $("#modalSessionName").text(sessionId);
    $("#modalLoader").show(); 
    $("#qrImage").hide().attr("src", ""); 
    $("#modalMessage").text("Menyiapkan sesi, mohon tunggu..."); 
    $("#qrModal").show();
  })
  .on("click", ".disconnect", function () {
    const sessionId = $(this).closest("tr").data("session");
    socket.emit("disconnectSession", sessionId);
  })
  .on("click", ".delete-session", function () {
    const sessionId = $(this).closest("tr").data("session");
    if (
      confirm(`Anda yakin ingin menghapus sesi "${sessionId}" secara permanen? Tindakan ini tidak bisa dibatalkan.`)
    ){
      socket.emit("deleteSession", sessionId);
    }
  });

socket
  .on("qr", ({ sessionId, url }) => {
    if ($("#modalSessionName").text() === sessionId) {
      $("#modalLoader").hide(); 
      $("#qrImage").attr("src", url).show(); 
      $("#modalMessage").text("Silakan scan QR code di atas.");
    }
  })
  .on("authenticated", ({ sessionId }) => {
    if ($("#modalSessionName").text() === sessionId) {
      $("#qrImage").hide(); 
      $("#modalLoader").show();
      $("#modalMessage").text("Autentikasi berhasil, menyiapkan sesi...");
    }
  })
  .on("ready", ({ sessionId, phoneNumber, pushname }) => {
    const row = $(`tr[data-session="${sessionId}"]`);
    row.find(".phone").text(phoneNumber);
    row.find(".name").text(pushname);
    row.find(".status").html("✅ Connected");
    row.find(".connect").hide();
    row.find(".disconnect").show();
    $("#qrModal").hide();
  })
  socket.on('message_ack', function(data) {
    const logContainer = $('ul.logs');
    const timestamp = moment().format('HH:mm:ss');
    const logMessage = `[${timestamp}] [${data.sesId}] ${data.id} STATUS: <strong>${data.ackName}</strong>.`;
    const newLogItem = `<li>${logMessage}</li>`;
    logContainer.prepend(newLogItem);
  })
  .on("response", function (res) {
    $("#responseServer").html(JSON.stringify(res, null, 4));
  })
  .on("disconnected", ({ sessionId }) => {
    const row = $(`tr[data-session="${sessionId}"]`);
    row.find(".status").html("❌ Disconnected");
    row.find(".connect").show();
    row.find(".disconnect").hide();
  })
  .on("sessionDeleted", (sessionId) => {
    $(`tr[data-session="${sessionId}"]`).remove();
  });

function showQrModal(sessionId) {
  $("#modalSessionName").text(sessionId);
  $("#qrModal").show();
}

function showError(message) {
  alert(`Error: ${message}`);
}

setInterval(function(){
  $('.logs').empty();
}, 1000*60*60*24*3) //3 Hari