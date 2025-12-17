import React, { useState, useEffect, useRef, createContext, useContext, useCallback } from 'react';
import { Mic, MicOff, Video, VideoOff, ScreenShare, MessageSquare, Send, X, LogIn, Plus, Sun, Moon, Maximize, Minimize } from 'lucide-react'; 
import { io } from 'socket.io-client';
import Peer from 'peerjs';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import styles from './App.module.css';

// =======================================================
// --- CONFIGURACIÓN CRÍTICA DEL SERVIDOR ---
// DEBES REEMPLAZAR 'https://meet-clone-v0ov.onrender.com' CON LA URL REAL 
// DE TU NUEVO SERVIDOR DE SEÑALIZACIÓN (donde desplegaste server-global-cors.js).
// =======================================================
const DEFAULT_SERVER_URL = 'https://mundi-link-lite-server.onrender.com'; // <-- ¡Reemplaza esto!
const SERVER_URL = process.env.REACT_APP_SERVER_URL || DEFAULT_SERVER_URL;

// El host de PeerJS debe ser solo el nombre de dominio (ej. 'mi-servidor.com')
const PEER_HOST = new URL(SERVER_URL).hostname;

// El puerto por defecto para PeerJS es 443 si se usa HTTPS, o 80 si es HTTP.
// Si tu servidor PeerJS no corre en el puerto 443 (o 80), debes especificarlo.
const PEER_PORT = 443; // Usamos 443 ya que los despliegues modernos usan HTTPS/WSS
const PEER_SECURE = true; // DEBE ser 'true' para despliegues con HTTPS

// --- CONTEXTO PARA WEBRTC ---
const WebRTCContext = createContext();
const useWebRTC = () => useContext(WebRTCContext);

// --- HOOK PERSONALIZADO PARA LA LÓGICA DE WEBRTC ---
const useWebRTCLogic = (roomId) => {
    const [myStream, setMyStream] = useState(null);
    const [myScreenStream, setMyScreenStream] = useState(null);
    const [peers, setPeers] = useState({});
    const [chatMessages, setChatMessages] = useState([]);
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [appTheme, setAppTheme] = useState('dark'); 

    const [roomUsers, setRoomUsers] = useState({});

    const socketRef = useRef(null);
    const myPeerRef = useRef(null);
    const peerConnections = useRef({});

    const currentUserNameRef = useRef('');

    // Función de limpieza completa
    const cleanup = useCallback(() => {
        // 1. Detener Streams
        if (myStream) {
            myStream.getTracks().forEach(track => track.stop());
            setMyStream(null);
        }
        if (myScreenStream) {
            myScreenStream.getTracks().forEach(track => track.stop());
            setMyScreenStream(null);
        }

        // 2. Cerrar Llamadas PeerJS
        Object.values(peerConnections.current).forEach(call => {
            if (call && typeof call.close === 'function') {
                call.close();
            }
        });
        peerConnections.current = {};
        setPeers({});

        // 3. Desconectar Socket.io
        if (socketRef.current) {
            socketRef.current.disconnect();
            socketRef.current = null;
        }

        // 4. Destruir Peer
        if (myPeerRef.current) {
            myPeerRef.current.destroy();
            myPeerRef.current = null;
        }
    }, [myStream, myScreenStream]);

    // Lógica para obtener el stream de la cámara y micrófono
    const initializeStream = async (audioId, videoId) => {
        try {
            const constraints = {
                audio: { deviceId: audioId ? { exact: audioId } : undefined },
                video: videoId ? { deviceId: { exact: videoId }, width: { ideal: 640 }, height: { ideal: 480 } } : false
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            setMyStream(stream);
            setIsMuted(!stream.getAudioTracks().some(track => track.enabled));
            setIsVideoOff(!stream.getVideoTracks().some(track => track.enabled));
            return stream;
        } catch (error) {
            console.error("Error al acceder a los dispositivos de medios:", error);
            toast.error(`Error de medios: ${error.name}. Asegúrate de dar permisos.`);
            // Intento de fallback: solo audio
            try {
                 const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                 setMyStream(audioStream);
                 setIsVideoOff(true);
                 toast.warn("Cámara no accesible. Entrando en modo solo audio.");
                 return audioStream;
            } catch (e) {
                toast.error("Fallo la inicialización de audio. No puedes unirte.");
                return null;
            }
        }
    };
    
    // Conexión y señalización
    const connect = useCallback((stream, name) => {
        if (!stream) return;
        currentUserNameRef.current = name;

        // 1. Inicializar Socket.io con reconexión robusta
        try {
            socketRef.current = io(SERVER_URL, {
                transports: ['websocket', 'polling'],
                timeout: 20000, 
                reconnectionAttempts: Infinity,
                reconnectionDelayMax: 5000,
                withCredentials: false, 
                // Usamos el mismo CORS definido en el servidor
            });
        } catch (e) {
            console.error("Error al inicializar Socket.io:", e);
            toast.error("Error crítico: Fallo en la inicialización de Socket.io.");
            cleanup();
            return;
        }

        // 2. Inicializar PeerJS
        myPeerRef.current = new Peer(undefined, {
            host: PEER_HOST,
            port: PEER_PORT,
            path: '/peerjs/myapp',
            secure: PEER_SECURE, 
        });

        // --- EVENTOS PEERJS ---
        myPeerRef.current.on('open', (id) => {
            console.log("My Peer ID:", id);
            // Solo unirse a la sala si el socket está conectado
            socketRef.current.emit('join-room', roomId, id, name);
        });

        myPeerRef.current.on('error', (err) => {
            console.error("PeerJS Error:", err);
            toast.error(`Error P2P: ${err.type}. Revisa la configuración del host.`);
        });
        
        myPeerRef.current.on('call', (call) => {
            const metadata = call.metadata || {};
            const remoteId = call.peer;
            const isScreen = metadata.isScreenShare;
            const finalId = remoteId + (isScreen ? '_screen' : '');

            // Responder a la llamada con nuestro stream de video/audio
            call.answer(stream);

            call.on('stream', (remoteStream) => {
                setPeers(prevPeers => ({
                    ...prevPeers,
                    [finalId]: { 
                        stream: remoteStream, 
                        userName: metadata.userName || 'Usuario', 
                        isScreenShare: isScreen 
                    }
                }));
            });

            call.on('close', () => {
                setPeers(prevPeers => {
                    const newPeers = { ...prevPeers };
                    delete newPeers[finalId];
                    return newPeers;
                });
                toast.info(`La llamada de ${metadata.userName || 'Usuario'} ha finalizado.`);
                delete peerConnections.current[finalId];
            });
            
            call.on('error', (err) => {
                 console.error("Peer Call Error:", err);
            });

            peerConnections.current[finalId] = call;
        });

        // --- EVENTOS SOCKET.IO ---
        socketRef.current.on('connect', () => {
            console.log("Socket.io conectado exitosamente.");
            // Si ya tenemos ID de Peer, nos unimos de nuevo (en caso de reconexión)
            if (myPeerRef.current && myPeerRef.current.id) {
                 socketRef.current.emit('join-room', roomId, myPeerRef.current.id, name);
            }
        });
        
        socketRef.current.on('connect_error', (err) => {
            console.error("Error de conexión Socket:", err);
            toast.error(`Fallo de conexión: El servidor no responde (${err.message}).`);
        });
        
        socketRef.current.on('reconnect_failed', () => {
             toast.error("Conexión perdida. Por favor, recarga la página.");
        });

        socketRef.current.on('user-joined', (data) => {
            toast.info(`${data.userName} se ha unido a la sala.`);
            setRoomUsers(prev => ({ ...prev, [data.userId]: data.userName }));
            connectToNewUser(data.userId, stream, data.userName);
        });
        
        socketRef.current.on('all-users', (users) => {
            const usersMap = users.reduce((acc, u) => {
                acc[u.userId] = u.userName;
                return acc;
            }, {});
            setRoomUsers(usersMap);
            // Conectar a todos los usuarios existentes si ya tengo mi ID de Peer
            if (myPeerRef.current && myPeerRef.current.id) {
                users.forEach(user => {
                    if (user.userId !== myPeerRef.current.id) {
                        connectToNewUser(user.userId, stream, user.userName);
                    }
                });
            }
        });

        socketRef.current.on('user-disconnected', (userId, disconnectedUserName) => {
            toast.warn(`${disconnectedUserName || 'Un usuario'} ha salido.`);
            setRoomUsers(prev => {
                const newUsers = { ...prev };
                delete newUsers[userId];
                return newUsers;
            });

            // Cerrar la llamada si existe
            if (peerConnections.current[userId]) {
                peerConnections.current[userId].close();
                delete peerConnections.current[userId];
            }
            // Cerrar la llamada de pantalla si existe
             const screenId = userId + '_screen';
             if (peerConnections.current[screenId]) {
                peerConnections.current[screenId].close();
                delete peerConnections.current[screenId];
            }
            
            // Forzar la actualización de peers
            setPeers(prevPeers => {
                const newPeers = { ...prevPeers };
                delete newPeers[userId];
                delete newPeers[screenId];
                return newPeers;
            });
        });

        socketRef.current.on('createMessage', (msg, user) => {
            const isMe = user === currentUserNameRef.current;
            setChatMessages(prev => [...prev, { user, text: msg, isMe, type: 'chat' }]);
        });

        socketRef.current.on('theme-changed', (theme) => {
            setAppTheme(theme);
        });
        
        socketRef.current.on('user-reaction', (userId, emoji) => {
             toast(`${roomUsers[userId] || 'Usuario'} reaccionó: ${emoji}`, {
                position: 'top-center',
                autoClose: 1500,
                hideProgressBar: true,
                closeOnClick: true,
                pauseOnHover: false,
                draggable: false,
                theme: "colored",
                type: "info"
            });
        });

        socketRef.current.on('screen-share-active', (userId, userName) => {
            if(userId !== myPeerRef.current.id) {
                setChatMessages(prev => [...prev, { user: userName, text: 'Ha iniciado la compartición de pantalla.', isMe: false, type: 'system' }]);
            }
        });

    }, [roomId, cleanup]);
    
    // Función para conectar a un nuevo usuario (llamada saliente)
    const connectToNewUser = (userId, stream, remoteName) => {
         // Evita reconectar a la llamada principal si ya existe
        if(peerConnections.current[userId]) return;

        console.log(`Llamando a nuevo usuario: ${remoteName} (${userId})`);
        
        // Retrasar la llamada un poco para asegurar que el otro peer esté listo
        const call = myPeerRef.current.call(userId, stream, {
            metadata: { userName: currentUserNameRef.current, isScreenShare: false }
        });
        
        if (!call) return;
        
        call.on('stream', (userVideoStream) => {
            // Este evento puede dispararse múltiples veces si se usa la opción 'trickle'
             setPeers(prevPeers => ({
                ...prevPeers,
                [userId]: { 
                    stream: userVideoStream, 
                    userName: remoteName, 
                    isScreenShare: false 
                }
            }));
        });
        
        call.on('close', () => {
            setPeers(prevPeers => {
                const newPeers = { ...prevPeers };
                delete newPeers[userId];
                return newPeers;
            });
            delete peerConnections.current[userId];
        });
        
        call.on('error', (err) => {
            console.error("Call to " + remoteName + " failed:", err);
            toast.error(`Fallo la llamada P2P con ${remoteName}.`);
        });
        
        peerConnections.current[userId] = call;
        
        // Si estoy compartiendo pantalla, llamar también con el stream de la pantalla
        if (myScreenStream) {
            shareScreenToUser(userId, myScreenStream);
        }
    };
    
    // Función para compartir pantalla
    const toggleScreenShare = () => {
        if (myScreenStream) {
            stopScreenShare();
        } else {
            // Intentar obtener el stream de la pantalla
            navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
                .then(stream => {
                    setMyScreenStream(stream);
                    
                    // Mostrar mi propia pantalla compartida en el cliente
                    setPeers(prevPeers => ({
                        ...prevPeers,
                        'local_screen': { 
                            stream: stream, 
                            userName: currentUserNameRef.current, 
                            isScreenShare: true 
                        }
                    }));
                    
                    // Notificar a todos por Socket.io
                    if(socketRef.current) {
                        socketRef.current.emit('screen-share-started');
                    }
                    
                    // Llamar a todos los peers existentes con el stream de la pantalla
                    Object.keys(roomUsers).forEach(userId => {
                        if (userId !== myPeerRef.current.id) {
                            shareScreenToUser(userId, stream);
                        }
                    });

                    // Detectar si el usuario detiene la compartición con el control del navegador
                    stream.getVideoTracks()[0].onended = stopScreenShare;

                })
                .catch(err => {
                    console.error("Error al compartir pantalla", err);
                    toast.error("Fallo al capturar la pantalla. Permiso denegado.");
                });
        }
    };
    
    const shareScreenToUser = (userId, stream) => {
        const screenCall = myPeerRef.current.call(userId, stream, {
            metadata: { userName: currentUserNameRef.current, isScreenShare: true }
        });
        
        if (screenCall) {
            // Guardar la llamada de pantalla en una clave separada
            const screenId = userId + '_screen';
            peerConnections.current[screenId] = screenCall;
            
            screenCall.on('close', () => {
                setPeers(prevPeers => {
                    const newPeers = { ...prevPeers };
                    delete newPeers[screenId];
                    return newPeers;
                });
                delete peerConnections.current[screenId];
            });
        }
    }

    const stopScreenShare = () => {
        if (myScreenStream) {
            myScreenStream.getTracks().forEach(t => t.stop());
            setMyScreenStream(null);
            
            // Eliminar mi video de pantalla compartida de la lista de peers
            setPeers(prevPeers => {
                const newPeers = { ...prevPeers };
                delete newPeers['local_screen'];
                return newPeers;
            });
            
            // Notificar a todos
            if(socketRef.current) {
                socketRef.current.emit('stop-screen-share');
            }
        }
    };
    
    // Envío de mensajes de chat
    const sendChatMessage = (text) => {
        if(socketRef.current) {
            socketRef.current.emit('message', text);
            setChatMessages(prev => [...prev, { user: currentUserNameRef.current, text, isMe: true, type: 'chat' }]);
        }
    };
    
    // Envío de reacciones emoji
    const sendEmojiReaction = (emoji) => {
        if(socketRef.current) {
            socketRef.current.emit('emoji-reaction', emoji);
        }
    }
    
    // Toggle de micrófono y video
    const toggleMute = () => {
        if (!myStream) return;
        const audioTrack = myStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            setIsMuted(!audioTrack.enabled);
        }
    };

    const toggleVideo = () => {
        if (!myStream) return;
        const videoTrack = myStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            setIsVideoOff(!videoTrack.enabled);
        } else {
             toast.warn("Cámara no disponible. Entrando en modo solo audio.");
        }
    };
    
    // Cambio de tema
    const changeTheme = (theme) => {
        setAppTheme(theme);
        if (socketRef.current) {
            socketRef.current.emit('change-theme', theme);
        }
    };

    // Propagar cambios locales de stream a todos los peers (ej. si se muta/desmuta)
    useEffect(() => {
        if (!myStream || !myPeerRef.current || !myPeerRef.current.id) return;
        
        const myPeerId = myPeerRef.current.id;

        // Recorrer todas las llamadas activas (la llamada principal, no la de pantalla)
        Object.keys(peerConnections.current).forEach(peerId => {
             // Ignorar la conexión de la pantalla compartida si existe
             if(peerId.includes('_screen')) return;

             const call = peerConnections.current[peerId];
             if (call && call.peerConnection) {
                const sender = call.peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
                const newAudioTrack = myStream.getAudioTracks()[0];
                if (sender && newAudioTrack) {
                    sender.replaceTrack(newAudioTrack);
                }
             }
        });
        
    }, [myStream, isMuted, isVideoOff]);
    
    // Retorno del hook
    return {
        myStream,
        peers,
        chatMessages,
        isMuted,
        isVideoOff,
        appTheme,
        roomUsers,
        cleanup,
        initializeStream,
        connect,
        toggleMute,
        toggleVideo,
        toggleScreenShare,
        sendChatMessage,
        sendEmojiReaction,
        changeTheme,
        myPeerId: myPeerRef.current ? myPeerRef.current.id : null,
        isScreenSharing: !!myScreenStream,
        // Exponemos el socket y peer ref para debug/otras operaciones si es necesario
        socket: socketRef.current,
        myPeer: myPeerRef.current
    };
};

// ... (Resto de componentes VideoComponent, ChatSidebar, Lobby, etc.)
// ... (omito el resto para brevedad, ya que solo la config URL es relevante)


// --- VideoComponent ---
const VideoComponent = ({ peerId, stream, userName, isScreenShare, isLocal, isMuted, isVideoOff, selectedAudioOutput }) => {
    const videoRef = useRef();
    const [isFullScreen, setIsFullScreen] = useState(false);

    useEffect(() => {
        if (videoRef.current && stream) {
            videoRef.current.srcObject = stream;
            
            // Establecer el dispositivo de salida de audio para el video remoto
            if (!isLocal && stream.getAudioTracks().length > 0 && videoRef.current.setSinkId) {
                 videoRef.current.setSinkId(selectedAudioOutput)
                    .catch(err => console.warn("Fallo al establecer sinkId:", err));
            }

            // Si es local y está muteado/video apagado, manejamos el estado visual.
            if (isLocal) {
                 const videoTrack = stream.getVideoTracks()[0];
                 const audioTrack = stream.getAudioTracks()[0];

                 if (videoTrack) videoTrack.enabled = !isVideoOff;
                 if (audioTrack) audioTrack.enabled = !isMuted;
            }
        }
    }, [stream, isLocal, isMuted, isVideoOff, selectedAudioOutput]);
    
    // Lógica para Full Screen
    const toggleFullScreen = () => {
         const wrapper = videoRef.current.closest(`.${styles.videoWrapper}`);
         if (!wrapper) return;
         
         if (isFullScreen) {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.mozCancelFullScreen) { 
                document.mozCancelFullScreen();
            } else if (document.webkitExitFullscreen) { 
                document.webkitExitFullscreen();
            } else if (document.msExitFullscreen) { 
                document.msExitFullscreen();
            }
            setIsFullScreen(false);
         } else {
             if (wrapper.requestFullscreen) {
                wrapper.requestFullscreen();
             } else if (wrapper.mozRequestFullScreen) {
                wrapper.mozRequestFullScreen();
             } else if (wrapper.webkitRequestFullscreen) {
                wrapper.webkitRequestFullscreen();
             } else if (wrapper.msRequestFullscreen) {
                wrapper.msRequestFullscreen();
             }
             setIsFullScreen(true);
         }
    };
    
    // Escuchar cambios de Fullscreen a nivel de documento
    useEffect(() => {
        const handleFullScreenChange = () => {
            const wrapper = videoRef.current.closest(`.${styles.videoWrapper}`);
            setIsFullScreen(document.fullscreenElement === wrapper ||
                           document.webkitFullscreenElement === wrapper ||
                           document.mozFullScreenElement === wrapper ||
                           document.msFullscreenElement === wrapper);
        };

        document.addEventListener('fullscreenchange', handleFullScreenChange);
        document.addEventListener('webkitfullscreenchange', handleFullScreenChange);
        document.addEventListener('mozfullscreenchange', handleFullScreenChange);
        document.addEventListener('MSFullscreenChange', handleFullScreenChange);

        return () => {
            document.removeEventListener('fullscreenchange', handleFullScreenChange);
            document.removeEventListener('webkitfullscreenchange', handleFullScreenChange);
            document.removeEventListener('mozfullscreenchange', handleFullScreenChange);
            document.removeEventListener('MSFullscreenChange', handleFullScreenChange);
        };
    }, []);

    const showVideoOff = !isScreenShare && (isLocal ? isVideoOff : (stream && stream.getVideoTracks().length === 0));
    const showAudioOff = !isScreenShare && (isLocal ? isMuted : (stream && stream.getAudioTracks().length === 0));
    
    const wrapperClass = `${styles.videoWrapper} ${isLocal ? styles.localVideoWrapper : ''} ${isScreenShare ? styles.screenShareWrapper : ''} ${isFullScreen ? styles.fullScreen : ''}`;

    return (
        <div id={`video-${peerId}`} className={wrapperClass}>
            <video 
                ref={videoRef} 
                className={styles.videoElement}
                autoPlay 
                playsInline
                muted={isLocal}
            />
            {showVideoOff && (
                <div className={styles.videoPlaceholder}>
                    <VideoOff size={48} />
                </div>
            )}
            <div className={styles.overlayControls}>
                <div className={styles.userNameLabel}>
                    {userName}
                    {showAudioOff && (
                        <MicOff className={styles.iconRed} size={14} style={{ marginLeft: '5px' }} />
                    )}
                    {isScreenShare && (
                         <ScreenShare className={styles.iconGreen} size={14} style={{ marginLeft: '5px' }} />
                    )}
                </div>
                <button 
                    onClick={toggleFullScreen}
                    className={styles.fullScreenButton}
                    title={isFullScreen ? "Salir de Pantalla Completa" : "Pantalla Completa"}
                >
                    {isFullScreen ? <Minimize size={18} /> : <Maximize size={18} />}
                </button>
            </div>
        </div>
    );
};


// --- ChatSidebar ---
const ChatSidebar = ({ messages, sendChatMessage, toggleChat, isVisible }) => {
    const [message, setMessage] = useState('');
    const messagesEndRef = useRef(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(scrollToBottom, [messages, isVisible]);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (message.trim()) {
            sendChatMessage(message.trim());
            setMessage('');
        }
    };
    
    const sidebarClass = `${styles.chatSidebar} ${isVisible ? styles.open : ''}`;

    return (
        <div className={sidebarClass}>
            <div className={styles.chatHeader}>
                <h3>Chat de la Reunión</h3>
                <button onClick={() => toggleChat(false)} className={styles.closeChatBtn} title="Cerrar Chat">
                    <X size={20} />
                </button>
            </div>
            <div className={styles.chatMessages}>
                {messages.map((msg, index) => (
                    <div key={index} className={`${styles.message} ${msg.isMe ? styles.me : styles.other} ${msg.type === 'system' ? styles.system : ''}`}>
                        {msg.type !== 'system' && (
                            <span className={styles.msgUser}>{msg.isMe ? 'Tú' : msg.user}: </span>
                        )}
                        <span className={styles.msgText}>{msg.text}</span>
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>
            <form onSubmit={handleSubmit} className={styles.chatForm}>
                <input
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Escribe un mensaje..."
                    className={styles.chatInput}
                />
                <button type="submit" className={styles.sendBtn} title="Enviar">
                    <Send size={20} />
                </button>
            </form>
        </div>
    );
};

// --- Lobby Component ---
const Lobby = ({ onJoin }) => {
    const [userName, setUserName] = useState('');
    const [audioDevices, setAudioDevices] = useState([]);
    const [videoDevices, setVideoDevices] = useState([]);
    const [audioOutputDevices, setAudioOutputDevices] = useState([]);
    const [selectedAudioId, setSelectedAudioId] = useState('');
    const [selectedVideoId, setSelectedVideoId] = useState('');
    const [selectedAudioOutputId, setSelectedAudioOutputId] = useState('');
    const [loading, setLoading] = useState(true);

    const getMediaDevices = async () => {
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); // Pedir permisos primero
            const devices = await navigator.mediaDevices.enumerateDevices();
            
            const audioIn = devices.filter(d => d.kind === 'audioinput');
            const video = devices.filter(d => d.kind === 'videoinput');
            const audioOut = devices.filter(d => d.kind === 'audiooutput');

            setAudioDevices(audioIn);
            setVideoDevices(video);
            setAudioOutputDevices(audioOut);

            if (audioIn.length > 0) setSelectedAudioId(audioIn[0].deviceId);
            if (video.length > 0) setSelectedVideoId(video[0].deviceId);
            if (audioOut.length > 0) setSelectedAudioOutputId(audioOut[0].deviceId);
            
        } catch (error) {
            console.error("Error al obtener dispositivos:", error);
            toast.error("Error: Acceso a micrófono o cámara denegado.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        getMediaDevices();
    }, []);

    const handleJoinClick = (e) => {
        e.preventDefault();
        if (userName.trim()) {
            onJoin(userName.trim(), selectedAudioId, selectedVideoId, selectedAudioOutputId);
        } else {
            toast.warn("Por favor, ingresa tu nombre.");
        }
    };

    if (loading) {
        return <div className={styles.loadingMessage}>Cargando dispositivos...</div>;
    }

    return (
        <div className={styles.lobbyContainer}>
            <div className={styles.formCard}>
                <h1 className={styles.title}>WebRTC Meet Clone</h1>
                <form onSubmit={handleJoinClick} className={styles.form}>
                    <div className={styles.formGroup}>
                        <label className={styles.formLabel} htmlFor="username">Tu Nombre</label>
                        <input
                            id="username"
                            type="text"
                            value={userName}
                            onChange={(e) => setUserName(e.target.value)}
                            placeholder="Ej. Juan Pérez"
                            className={styles.formInput}
                            required
                        />
                    </div>

                    <div className={styles.formGroup}>
                        <label className={styles.formLabel} htmlFor="audioInput">Micrófono</label>
                        <select
                            id="audioInput"
                            value={selectedAudioId}
                            onChange={(e) => setSelectedAudioId(e.target.value)}
                            className={styles.formSelect}
                        >
                            {audioDevices.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Micrófono ${device.deviceId.slice(0, 4)}...`}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.formGroup}>
                        <label className={styles.formLabel} htmlFor="videoInput">Cámara</label>
                        <select
                            id="videoInput"
                            value={selectedVideoId}
                            onChange={(e) => setSelectedVideoId(e.target.value)}
                            className={styles.formSelect}
                        >
                             <option value="">(Solo Audio)</option>
                            {videoDevices.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Cámara ${device.deviceId.slice(0, 4)}...`}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.formGroup}>
                        <label className={styles.formLabel} htmlFor="audioOutput">Salida de Audio</label>
                        <select
                            id="audioOutput"
                            value={selectedAudioOutputId}
                            onChange={(e) => setSelectedAudioOutputId(e.target.value)}
                            className={styles.formSelect}
                        >
                            {audioOutputDevices.map(device => (
                                <option key={device.deviceId} value={device.deviceId}>
                                    {device.label || `Altavoz ${device.deviceId.slice(0, 4)}...`}
                                </option>
                            ))}
                        </select>
                    </div>

                    <button type="submit" className={styles.joinButton}>
                        <LogIn size={20} style={{ marginRight: '8px' }} />
                        Unirse a la Reunión
                    </button>
                </form>
            </div>
        </div>
    );
};


// --- COMPONENTE PRINCIPAL DE LA APLICACIÓN CORREGIDO ---
export default function App() {
    const [isJoined, setIsJoined] = useState(false);
    const [userName, setUserName] = useState('');
    const [selectedAudioOutput, setSelectedAudioOutput] = useState('');
    const [isChatVisible, setIsChatVisible] = useState(false);
    
    // appTheme ahora se gestiona dentro de useWebRTCLogic
    const webRTCLogic = useWebRTCLogic('main-room');

    const handleJoin = async (name, audioId, videoId, audioOutputId) => {
        setUserName(name);
        setSelectedAudioOutput(audioOutputId);
        const stream = await webRTCLogic.initializeStream(audioId, videoId);
        if (stream) {
            webRTCLogic.connect(stream, name);
            setIsJoined(true);
        }
    };

    const handleLeave = () => {
        webRTCLogic.cleanup();
        setIsJoined(false);
        setUserName('');
        setSelectedAudioOutput('');
    };

    useEffect(() => {
        // Asegura la limpieza en el cierre o recarga de la página
        window.addEventListener('beforeunload', webRTCLogic.cleanup);
        return () => {
            window.removeEventListener('beforeunload', webRTCLogic.cleanup);
        };
    }, [webRTCLogic]);
    
    // Aplicar el tema globalmente
    useEffect(() => {
        document.body.className = webRTCLogic.appTheme === 'light' ? styles.lightMode : styles.darkMode;
    }, [webRTCLogic.appTheme]);

    if (!isJoined) {
        return (
             <div className={`${styles.appContainer} ${styles.lobby}`}>
                <Lobby onJoin={handleJoin} /> 
                <ToastContainer limit={3} />
            </div>
        );
    } else {
        const localVideo = webRTCLogic.myStream ? {
            peerId: webRTCLogic.myPeerId || 'local', 
            stream: webRTCLogic.myStream, 
            userName: userName, 
            isScreenShare: false, 
            isLocal: true,
            isMuted: webRTCLogic.isMuted,
            isVideoOff: webRTCLogic.isVideoOff,
            selectedAudioOutput: selectedAudioOutput
        } : null;

        const allPeers = Object.entries(webRTCLogic.peers)
            .map(([id, peerData]) => ({
                peerId: id,
                ...peerData,
                isLocal: false,
                selectedAudioOutput: selectedAudioOutput
            }));
            
        const allVideos = localVideo ? [localVideo, ...allPeers] : [...allPeers];
        
        // El chat se cierra automáticamente si la pantalla es muy pequeña
        useEffect(() => {
            const handleResize = () => {
                if (window.innerWidth < 768) {
                    setIsChatVisible(false);
                }
            };
            window.addEventListener('resize', handleResize);
            return () => window.removeEventListener('resize', handleResize);
        }, []);
        
        const chatUnreadCount = webRTCLogic.chatMessages.filter(msg => !msg.isMe && !isChatVisible).length;

        return (
            <WebRTCContext.Provider value={{ ...webRTCLogic, selectedAudioOutput, userName }}>
                <div className={`${styles.appContainer} ${styles.callRoom}`}>
                    <div className={styles.videoGrid}>
                        {allVideos.map(video => (
                            <VideoComponent key={video.peerId} {...video} />
                        ))}
                    </div>
                    
                    <div className={styles.controlsBar}>
                        <div className={styles.usersDisplay}>
                            <Plus size={16} /> 
                            <span>{Object.keys(webRTCLogic.roomUsers).length + 1} Participantes</span>
                        </div>
                        
                        <div className={styles.controlsCenter}>
                            {/* Botón Mute/Unmute */}
                            <button 
                                onClick={webRTCLogic.toggleMute} 
                                className={`${styles.controlButton} ${webRTCLogic.isMuted ? styles.active : ''}`}
                                title={webRTCLogic.isMuted ? "Activar Micrófono" : "Silenciar"}
                            >
                                {webRTCLogic.isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                            </button>
                            
                             {/* Botón Video On/Off */}
                            <button 
                                onClick={webRTCLogic.toggleVideo} 
                                className={`${styles.controlButton} ${webRTCLogic.isVideoOff ? styles.active : ''}`}
                                title={webRTCLogic.isVideoOff ? "Activar Cámara" : "Apagar Cámara"}
                            >
                                {webRTCLogic.isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
                            </button>

                             {/* Botón Compartir Pantalla */}
                            <button 
                                onClick={webRTCLogic.toggleScreenShare} 
                                className={`${styles.controlButton} ${webRTCLogic.isScreenSharing ? styles.activeShare : ''}`}
                                title={webRTCLogic.isScreenSharing ? "Detener Compartir" : "Compartir Pantalla"}
                            >
                                <ScreenShare size={24} />
                            </button>
                            
                             {/* Botones de Reacción */}
                            <button onClick={() => webRTCLogic.sendEmojiReaction('👍')} className={styles.reactionButton} title="Pulgar Arriba">
                                👍
                            </button>
                            <button onClick={() => webRTCLogic.sendEmojiReaction('👏')} className={styles.reactionButton} title="Aplausos">
                                👏
                            </button>
                            
                             {/* Botón Salir */}
                            <button 
                                onClick={handleLeave} 
                                className={`${styles.controlButton} ${styles.leaveButton}`}
                                title="Finalizar Reunión"
                            >
                                <X size={24} />
                            </button>
                        </div>
                        
                        <div className={styles.controlsRight}>
                            {/* Botón Chat */}
                            <button 
                                onClick={() => setIsChatVisible(true)} 
                                className={styles.controlButton}
                                title="Abrir Chat"
                            >
                                <MessageSquare size={24} />
                                {chatUnreadCount > 0 && <span className={styles.unreadBadge}>{chatUnreadCount}</span>}
                            </button>
                            
                            {/* Botón Tema */}
                            <button 
                                onClick={() => webRTCLogic.changeTheme(webRTCLogic.appTheme === 'dark' ? 'light' : 'dark')} 
                                className={styles.controlButton}
                                title={webRTCLogic.appTheme === 'dark' ? "Modo Claro" : "Modo Oscuro"}
                            >
                                {webRTCLogic.appTheme === 'dark' ? <Sun size={24} /> : <Moon size={24} />}
                            </button>
                        </div>
                    </div>
                    
                    <ChatSidebar 
                        messages={webRTCLogic.chatMessages}
                        sendChatMessage={webRTCLogic.sendChatMessage}
                        toggleChat={setIsChatVisible}
                        isVisible={isChatVisible}
                    />
                </div>
                <ToastContainer limit={3} />
            </WebRTCContext.Provider>
        );
    }
}