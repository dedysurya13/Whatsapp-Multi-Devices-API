const socket = io();

$(document).ready(function () {
  // Muat sesi yang tersimpan
  $.get("/api/sessions")
    .done((sessions) => {
      sessions.forEach((session) => {
        addSessionRow(
          session.sessionId,
          session.phoneNumber,
          session.pushname,
          session.connected
        );

        // Langsung bergabung ke room socket agar bisa menerima update status
        socket.emit("joinSession", session.sessionId);
      });
    })
    .fail((err) => showError(err.responseJSON.error));

  // Handle tambah session
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

  // Handle modal
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
      </td>
    </tr>
  `;
  $("#sessions tbody").append(row);
}

// Handle session events
$(document)
  .on("click", ".connect", function () {
    const sessionId = $(this).closest("tr").data("session");
    socket.emit("joinSession", sessionId);
    showQrModal(sessionId);
  })
  .on("click", ".disconnect", function () {
    const sessionId = $(this).closest("tr").data("session");
    socket.emit("disconnectSession", sessionId);
  });

socket
  .on("qr", ({ sessionId, url }) => {
    $("#modalSessionName").text(sessionId);
    $("#qrImage").attr("src", url);
    $("#qrModal").show();
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
  .on("disconnected", ({ sessionId }) => {
    const row = $(`tr[data-session="${sessionId}"]`);
    row.find(".status").html("❌ Disconnected");
    row.find(".connect").show();
    row.find(".disconnect").hide();
  });

function showQrModal(sessionId) {
  $("#modalSessionName").text(sessionId);
  $("#qrModal").show();
}

function showError(message) {
  alert(`Error: ${message}`);
}
