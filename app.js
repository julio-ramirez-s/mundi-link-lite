// app.js - ES5 Puro compatible con Android 5.1
// CORRECCIÓN: Socket.io v4 client y conexión más robusta.

// --- ESTADO GLOBAL ---
var state = {
    myStream: null,
    myScreenStream: null,
    peers: {}, // Mapa de peerId -> objeto call
    userName: '',
    roomId: 'main-room',
    isMuted: false,
    isVideoOff: false,
    theme: 'dark',
    socket: null,
    myPeer: null,
    isMobile: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
};

// URL del servidor (Backend original)
// Asegúrate de que este servidor esté ACTIVO. Si está en Render.com, podría estar dormido.
var SERVER_URL = "https://mundi-link-lite-server.onrender.com";

// --- ELEMENTOS DOM (Cache) ---
var dom = {
    lobby: document.getElementById('lobbyContainer'),
    callRoom: document.getElementById('callContainer'),
    joinBtn: document.getElementById('joinBtn'),
    usernameInput: document.getElementById('usernameInput'),
    videoGrid: document.getElementById('videoGrid'),
    muteBtn: document.getElementById('muteBtn'),
    videoBtn: document.getElementById('videoBtn'),
    shareBtn: document.getElementById('shareBtn'),
    chatToggleBtn: document.getElementById('chatToggleBtn'),
    chatSidebar: document.getElementById('chatSidebar'),
    closeChatBtn: document.getElementById('closeChatBtn'),
    chatForm: document.getElementById('chatForm'),
    chatInput: document.getElementById('chatInput'),
    chatMessages: document.getElementById('chatMessages'),
    leaveBtn: document.getElementById('leaveBtn'),
    themeDarkBtn: document.getElementById('themeDarkBtn'),
    themeLightBtn: document.getElementById('themeLightBtn'),
    statusMsg: document.getElementById('statusMsg')
};

// --- INICIALIZACIÓN ---
window.onload = function() {
    if (state.isMobile) {
        dom.shareBtn.style.display = 'none';
    }

    dom.joinBtn.onclick = joinRoom;
    
    // Controles
    dom.muteBtn.onclick = toggleMute;
    dom.videoBtn.onclick = toggleVideo;
    dom.shareBtn.onclick = toggleScreenShare;
    dom.leaveBtn.onclick = leaveRoom;
    
    // Chat
    dom.chatToggleBtn.onclick = function() { toggleChat(true); };
    dom.closeChatBtn.onclick = function() { toggleChat(false); };
    dom.chatForm.onsubmit = sendMessage;

    // Tema
    dom.themeDarkBtn.onclick = function() { changeTheme('dark'); };
    dom.themeLightBtn.onclick = function() { changeTheme('light'); };
};

// --- LÓGICA DE CONEXIÓN ROBUSTA (Cámara) ---

function getRobustMedia() {
    // Función de soporte para acceder a getUserMedia en navegadores antiguos
    var getUserMedia = (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) 
        ? function(c) { return navigator.mediaDevices.getUserMedia(c); }
        : function(c) {
            return new Promise(function(resolve, reject) {
                var getUserMediaLegacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
                if (!getUserMediaLegacy) {
                    return reject(new Error("WebRTC no soportado en este navegador"));
                }
                getUserMediaLegacy.call(navigator, c, resolve, reject);
            });
        };

    // 1. Low Res (320x240)
    var constraintsLow = { 
        audio: true, 
        video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } } 
    };

    // 2. Default
    var constraintsDefault = { audio: true, video: true };

    return new Promise(function(resolve, reject) {
        console.log("Intento 1: Video Baja Resolución");
        getUserMedia(constraintsLow)
            .then(resolve)
            .catch(function(err1) {
                console.warn("Fallo intento 1:", err1.name);
                if (err1.name === 'NotAllowedError' || err1.name === 'PermissionDeniedError') {
                    return reject(err1);
                }
                console.log("Intento 2: Video Default");
                dom.statusMsg.innerText = "Reintentando cámara...";
                getUserMedia(constraintsDefault)
                    .then(resolve)
                    .catch(function(err2) {
                        console.warn("Fallo intento 2:", err2.name);
                        console.log("Intento 3: Solo Audio");
                        dom.statusMsg.innerText = "Cámara falló. Entrando con solo audio...";
                        
                        // 3. Audio Only
                        var constraintsAudio = { audio: true, video: false };
                        getUserMedia(constraintsAudio)
                            .then(function(audioStream) {
                                // No usamos alert, sino el mensaje
                                dom.statusMsg.innerText = "Advertencia: Solo Audio. Entrando a la sala...";
                                resolve(audioStream);
                            })
                            .catch(function(err3) {
                                reject(err2); 
                            });
                    });
            });
    });
}

function joinRoom() {
    var name = dom.usernameInput.value;
    if (!name) { 
        // Reemplazar alert con mensaje en la UI
        dom.statusMsg.innerText = "Por favor ingresa un nombre."; 
        return; 
    }
    
    state.userName = name;
    dom.statusMsg.innerText = "Conectando...";
    dom.joinBtn.disabled = true;

    getRobustMedia()
        .then(function(stream) {
            state.myStream = stream;
            var hasVideo = stream.getVideoTracks().length > 0;
            addVideo(stream, state.userName, true, false);
            
            if (!hasVideo) {
                state.isVideoOff = true;
                dom.videoBtn.innerHTML = '<i class="fa fa-ban"></i>';
                dom.videoBtn.disabled = true;
            }

            initSocketAndPeer();
        })
        .catch(function(err) {
            console.error("Error fatal al obtener medios:", err);
            // Usamos un modal o un mensaje en lugar de alert()
            dom.statusMsg.innerText = "Error de acceso: " + (err.name || "Desconocido") + ". Verifica permisos.";
            dom.joinBtn.disabled = false;
        });
}

function initSocketAndPeer() {
    // 2. Conectar Socket.io (Versión 4.x Client - Más robusto)
    try {
        state.socket = io(SERVER_URL, {
            // Configuración para Render: confiamos en que el cliente negociará,
            // pero hacemos la conexión más robusta con timeouts y reconexión.
            transports: ['websocket', 'polling'],
            timeout: 20000, // Tiempo límite de conexión (20s)
            reconnectionAttempts: Infinity, // Intentos infinitos de reconexión
            reconnectionDelay: 1000, // Primer retraso de reconexión (1s)
            reconnectionDelayMax: 5000, // Retraso máximo (5s)
            withCredentials: false, 
        });
    } catch (e) {
        console.error("Error al inicializar Socket.io:", e);
        dom.statusMsg.innerText = "Error crítico: Fallo en la inicialización de Socket.io.";
        return;
    }

    // 3. Conectar PeerJS (Simplificado para Render)
    state.myPeer = new Peer(undefined, {
        // Al estar en el mismo host que el socket, podemos simplificar la configuración.
        host: 'meet-clone-v0ov.onrender.com', 
        path: '/peerjs/myapp', // Asegúrate de que esta ruta sea correcta en el servidor
    });

    state.myPeer.on('open', function(id) {
        console.log("My Peer ID: " + id);
        
        // Esperar la conexión del socket antes de emitir join-room
        if (state.socket.connected) {
             state.socket.emit('join-room', state.roomId, id, state.userName);
             dom.lobby.style.display = 'none';
             dom.callRoom.style.display = 'block';
             dom.statusMsg.innerText = "";
        } else {
            // Si no está conectado, esperar el evento 'connect'
            state.socket.once('connect', function() {
                console.log("Socket re-conectado. Uniéndose a la sala.");
                state.socket.emit('join-room', state.roomId, id, state.userName);
                dom.lobby.style.display = 'none';
                dom.callRoom.style.display = 'block';
                dom.statusMsg.innerText = "";
            });
        }
    });
    
    // Manejo de errores de PeerJS
    state.myPeer.on('error', function(err) {
        console.error("PeerJS Error:", err);
        dom.statusMsg.innerText = "Error P2P: " + err.type;
    });

    // --- EVENTOS SOCKET ---
    state.socket.on('connect', function() {
        console.log("Socket.io conectado exitosamente.");
    });
    
    state.socket.on('connect_error', function(err) {
        console.error("Error de conexión Socket:", err);
        dom.statusMsg.innerText = "Error de conexión: " + (err.message || 'El servidor no responde.');
        // Reintentar si el error fue un timeout. El cliente ya reintenta por sí mismo.
    });

    state.socket.on('user-joined', function(data) {
        console.log("Usuario unido:", data.userName);
        addMessageSystem(data.userName + " se ha unido.");
        connectToNewUser(data.userId, state.myStream, data.userName);
    });

    state.socket.on('user-disconnected', function(userId, disconnectedUserName) {
        console.log("Usuario desconectado:", disconnectedUserName);
        if (state.peers[userId]) {
            state.peers[userId].close();
            delete state.peers[userId];
        }
        removeVideo(userId);
        addMessageSystem((disconnectedUserName || "Usuario") + " salió.");
    });

    state.socket.on('createMessage', function(msg, user) {
        addMessageChat(user, msg, user === state.userName);
    });

    state.socket.on('theme-changed', function(theme) {
        applyTheme(theme);
    });

    state.socket.on('user-started-screen-share', function(data) {
        addMessageSystem(data.userName + " está compartiendo pantalla.");
    });
    
    state.socket.on('user-stopped-screen-share', function(userId) {
       // No necesitamos hacer nada aquí explícitamente, PeerJS maneja el cierre de la llamada de pantalla.
       // Se puede agregar un mensaje de sistema si se desea.
    });
    
    state.socket.on('reconnect_failed', function() {
        console.error("Fallo la reconexión con Socket.io después de varios intentos.");
        dom.statusMsg.innerText = "Conexión perdida. Por favor, recarga la página.";
    });


    // --- EVENTOS PEERJS ---
    state.myPeer.on('call', function(call) {
        var metadata = call.metadata || {};
        var isScreen = metadata.isScreenShare;
        
        call.answer(state.myStream); 

        call.on('stream', function(remoteStream) {
            var remoteId = call.peer;
            if (isScreen) remoteId += "_screen";
            
            if (document.getElementById('video-' + remoteId)) return;
            addVideo(remoteStream, metadata.userName || 'Usuario', false, isScreen, remoteId);
        });

        call.on('close', function() {
            var remoteId = call.peer;
            if (isScreen) remoteId += "_screen";
            removeVideo(remoteId);
        });

        state.peers[call.peer + (isScreen ? '_screen' : '')] = call;
    });
}

function connectToNewUser(userId, stream, remoteName) {
    // Retrasar levemente la llamada para asegurar que el otro peer esté listo
    setTimeout(function() {
        var call = state.myPeer.call(userId, stream, {
            metadata: { userName: state.userName, isScreenShare: false }
        });

        if (!call) return;

        call.on('stream', function(userVideoStream) {
            if (document.getElementById('video-' + userId)) return;
            addVideo(userVideoStream, remoteName, false, false, userId);
        });

        call.on('close', function() {
            removeVideo(userId);
        });

        state.peers[userId] = call;

        // Si estoy compartiendo pantalla, también llamo al nuevo usuario con la pantalla.
        if (state.myScreenStream) {
            var screenCall = state.myPeer.call(userId, state.myScreenStream, {
                metadata: { userName: state.userName, isScreenShare: true }
            });
            // Almacenar también la llamada de pantalla si es necesario para el control, pero es efímera.
        }
    }, 1000); // Esperar 1s antes de llamar
}

// --- FUNCIONES UI VIDEO ---

function addVideo(stream, name, isLocal, isScreen, id) {
    // Evitar duplicados
    var finalId = 'video-' + (id || 'local' + (isScreen ? '-screen' : ''));
    var existingWrapper = document.getElementById(finalId);
    if (existingWrapper) return; // Ya existe

    var wrapper = document.createElement('div');
    wrapper.className = 'videoWrapper';
    if (isScreen) wrapper.className += ' isScreen';
    wrapper.id = finalId;

    var hasVideoTrack = stream.getVideoTracks().length > 0 && stream.getVideoTracks()[0].enabled;

    var video = document.createElement('video');
    video.className = 'videoElement';
    if (isLocal && !isScreen) video.className += ' localVideo';
    
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true; 
    if (isLocal) video.muted = true; 
    
    // Iniciar la carga del video
    video.onloadedmetadata = function(e) {
        video.play();
    };

    var label = document.createElement('div');
    label.className = 'userNameLabel';
    label.innerText = name + (isScreen ? ' (Pantalla)' : '') + (!hasVideoTrack ? ' (Audio)' : '');

    if (!hasVideoTrack) {
        wrapper.style.background = "#333";
        wrapper.style.display = "flex";
        wrapper.style.alignItems = "center";
        wrapper.style.justifyContent = "center";
        var icon = document.createElement('i');
        icon.className = "fa fa-microphone fa-3x";
        icon.style.color = "#ccc";
        icon.style.zIndex = "1";
        wrapper.appendChild(icon);
    }

    wrapper.appendChild(video);
    wrapper.appendChild(label);
    dom.videoGrid.appendChild(wrapper);
}

function removeVideo(id) {
    var el = document.getElementById('video-' + id);
    if (el) {
        // Detener los streams asociados antes de remover (especialmente si es local)
        var videoElement = el.querySelector('video');
        if (videoElement && videoElement.srcObject) {
            videoElement.srcObject.getTracks().forEach(function(track) {
                // Solo detener si no es el stream principal (ya que ese se detiene al salir)
                // Esto es más relevante para el stream de pantalla remota
            });
        }
        el.parentNode.removeChild(el);
    }
}

// --- FUNCIONES DE CONTROLES ---

function toggleMute() {
    if (!state.myStream) return;
    var audioTrack = state.myStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        state.isMuted = !state.isMuted;
        dom.muteBtn.className = state.isMuted ? 'controlButton active' : 'controlButton';
        dom.muteBtn.innerHTML = state.isMuted ? '<i class="fa fa-microphone-slash"></i>' : '<i class="fa fa-microphone"></i>';
    }
}

function toggleVideo() {
    if (!state.myStream) return;
    var videoTracks = state.myStream.getVideoTracks();
    if (videoTracks.length > 0) {
        var videoTrack = videoTracks[0];
        videoTrack.enabled = !videoTrack.enabled;
        state.isVideoOff = !state.isVideoOff;
        dom.videoBtn.className = state.isVideoOff ? 'controlButton active' : 'controlButton';
        dom.videoBtn.innerHTML = state.isVideoOff ? '<i class="fa fa-video-camera"></i> <i class="fa fa-ban" style="font-size: 10px;"></i>' : '<i class="fa fa-video-camera"></i>';
    } else {
        // En lugar de alert, usamos el mensaje de estado si la cámara nunca fue capturada
        dom.statusMsg.innerText = "Cámara no disponible: Modo solo audio.";
    }
}

function toggleScreenShare() {
    if (state.myScreenStream) {
        stopScreenShare();
    } else {
        // Aseguramos que la función exista
        if (!navigator.mediaDevices.getDisplayMedia) {
             dom.statusMsg.innerText = "Compartir pantalla no soportado en este dispositivo/navegador.";
             return;
        }

        navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }) // Audio solo si es necesario
            .then(function(stream) {
                state.myScreenStream = stream;
                dom.shareBtn.className = 'controlButton activeShare';
                
                // Mostrar mi propia pantalla compartida
                addVideo(stream, state.userName, true, true, 'local-screen');
                state.socket.emit('start-screen-share', state.myPeer.id, state.userName);

                // Llamar a todos los peers con el stream de la pantalla
                for (var peerId in state.peers) {
                    if (!peerId.includes('_screen')) { // Solo llamar a los peers de video principal
                        state.myPeer.call(peerId, stream, {
                            metadata: { userName: state.userName, isScreenShare: true }
                        });
                    }
                }

                // Si el usuario detiene la compartición usando los controles del navegador
                stream.getVideoTracks()[0].onended = function() {
                    stopScreenShare();
                };
            })
            .catch(function(err) {
                console.error("Error al compartir pantalla", err);
                 dom.statusMsg.innerText = "Fallo al capturar la pantalla. Permiso denegado o error.";
            });
    }
}

function stopScreenShare() {
    if (state.myScreenStream) {
        // Detener todas las pistas de mi stream de pantalla
        state.myScreenStream.getTracks().forEach(function(t) { t.stop(); });
        state.myScreenStream = null;
        dom.shareBtn.className = 'controlButton';
        removeVideo('local-screen');
        state.socket.emit('stop-screen-share');
    }
}

function toggleChat(open) {
    if (open) dom.chatSidebar.className = 'chatSidebar open';
    else dom.chatSidebar.className = 'chatSidebar';
}

function sendMessage(e) {
    e.preventDefault();
    var txt = dom.chatInput.value.trim();
    if (txt && state.socket) {
        state.socket.emit('message', txt);
        dom.chatInput.value = '';
    }
}

function addMessageChat(user, text, isMe) {
    var div = document.createElement('div');
    div.className = 'message ' + (isMe ? 'me' : 'other');
    
    var spanUser = document.createElement('span');
    spanUser.className = 'msgUser';
    spanUser.innerText = isMe ? 'Tú' : user;
    
    var spanText = document.createElement('span');
    spanText.innerText = text;
    
    div.appendChild(spanUser);
    div.appendChild(spanText);
    dom.chatMessages.appendChild(div);
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function addMessageSystem(text) {
    var div = document.createElement('div');
    div.className = 'message system';
    div.innerText = text;
    dom.chatMessages.appendChild(div);
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

// --- TEMA ---
function changeTheme(theme) {
    applyTheme(theme);
    if (state.socket) {
        state.socket.emit('change-theme', theme);
    }
}

function applyTheme(theme) {
    state.theme = theme;
    if (theme === 'light') {
        document.body.classList.add('lightMode');
        document.body.classList.remove('darkMode');
    } else {
        document.body.classList.remove('lightMode');
        document.body.classList.add('darkMode');
    }
}

function leaveRoom() {
    // Limpieza de streams
    if (state.myStream) {
        state.myStream.getTracks().forEach(function(track) { track.stop(); });
    }
    stopScreenShare();
    
    // Desconexión de socket (si está conectado)
    if (state.socket) {
        state.socket.disconnect();
    }
    
    // Desconexión de PeerJS
    if (state.myPeer) {
        state.myPeer.destroy();
    }
    
    // Recargar la página para volver al lobby de forma limpia
    window.location.reload();
}