import { useSyncExternalStore } from "react";

export type AppLanguage = "en" | "es" | "fr" | "de" | "it" | "pt";

export const APP_LANGUAGES: Array<{ code: AppLanguage; label: string }> = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" }
];

const APP_LANGUAGE_KEY = "iptvmate_setup_language";

const translations = {
  en: {
    welcome: "Welcome",
    chooseAction: "Choose an action to start your session",
    loadingPlaylists: "Loading Saved Playlists...",
    liveTv: "Live TV",
    addFirstPlaylist: "Add Your First Playlist",
    movies: "Movies",
    series: "Series",
    loaded: "Loaded",
    total: "total",
    live: "live",
    checkingStorage: "Checking browser storage for saved playlists.",
    noPlaylists: "No playlists found. Add one first to load channels.",
    addPlaylist: "Add Playlist",
    playlistManager: "Playlist Manager",
    tvGuideSearch: "TV Guide Search",
    setup: "Setup",
    logout: "Logout",
    setupTitle: "Recording Setup",
    loginRequired: "Login Required",
    enableLogin: "Enable Login",
    masterCode: "Master Code",
    adultCode: "Adult Code",
    childCode: "Child Code",
    set: "Set",
    darkMode: "Dark Mode",
    lightMode: "Light Mode",
    buffer: "Buffer",
    off: "Off",
    low: "Low",
    medium: "Medium",
    high: "High",
    language: "Language",
    exitSetup: "Exit Setup",
    programVersion: "Program Version"
  },
  es: {
    welcome: "Bienvenido", chooseAction: "Elige una acción para iniciar tu sesión", loadingPlaylists: "Cargando listas guardadas...", liveTv: "TV en vivo", addFirstPlaylist: "Añade tu primera lista", movies: "Películas", series: "Series", loaded: "Cargado", total: "total", live: "en vivo", checkingStorage: "Buscando listas guardadas en el navegador.", noPlaylists: "No se encontraron listas. Añade una para cargar canales.", addPlaylist: "Añadir lista", playlistManager: "Administrador de listas", tvGuideSearch: "Buscar guía de TV", setup: "Configuración", logout: "Cerrar sesión", setupTitle: "Configuración de grabación", loginRequired: "Inicio de sesión requerido", enableLogin: "Activar inicio de sesión", masterCode: "Código maestro", adultCode: "Código adulto", childCode: "Código infantil", set: "Definido", darkMode: "Modo oscuro", lightMode: "Modo claro", buffer: "Búfer", off: "Desactivado", low: "Bajo", medium: "Medio", high: "Alto", language: "Idioma", exitSetup: "Salir de configuración", programVersion: "Versión del programa"
  },
  fr: {
    welcome: "Bienvenue", chooseAction: "Choisissez une action pour démarrer votre session", loadingPlaylists: "Chargement des listes enregistrées...", liveTv: "TV en direct", addFirstPlaylist: "Ajoutez votre première liste", movies: "Films", series: "Séries", loaded: "Chargé", total: "total", live: "direct", checkingStorage: "Recherche des listes enregistrées dans le navigateur.", noPlaylists: "Aucune liste trouvée. Ajoutez-en une pour charger les chaînes.", addPlaylist: "Ajouter une liste", playlistManager: "Gestionnaire de listes", tvGuideSearch: "Recherche du guide TV", setup: "Configuration", logout: "Déconnexion", setupTitle: "Configuration des enregistrements", loginRequired: "Connexion requise", enableLogin: "Activer la connexion", masterCode: "Code principal", adultCode: "Code adulte", childCode: "Code enfant", set: "Défini", darkMode: "Mode sombre", lightMode: "Mode clair", buffer: "Tampon", off: "Désactivé", low: "Faible", medium: "Moyen", high: "Élevé", language: "Langue", exitSetup: "Quitter la configuration", programVersion: "Version du programme"
  },
  de: {
    welcome: "Willkommen", chooseAction: "Wähle eine Aktion, um deine Sitzung zu starten", loadingPlaylists: "Gespeicherte Wiedergabelisten werden geladen...", liveTv: "Live-TV", addFirstPlaylist: "Erste Wiedergabeliste hinzufügen", movies: "Filme", series: "Serien", loaded: "Geladen", total: "gesamt", live: "live", checkingStorage: "Browserspeicher wird nach Wiedergabelisten durchsucht.", noPlaylists: "Keine Wiedergabelisten gefunden. Füge zuerst eine hinzu.", addPlaylist: "Wiedergabeliste hinzufügen", playlistManager: "Wiedergabelisten verwalten", tvGuideSearch: "TV-Guide-Suche", setup: "Einstellungen", logout: "Abmelden", setupTitle: "Aufnahmeeinstellungen", loginRequired: "Anmeldung erforderlich", enableLogin: "Anmeldung aktivieren", masterCode: "Mastercode", adultCode: "Erwachsenencode", childCode: "Kindercode", set: "Gesetzt", darkMode: "Dunkler Modus", lightMode: "Heller Modus", buffer: "Puffer", off: "Aus", low: "Niedrig", medium: "Mittel", high: "Hoch", language: "Sprache", exitSetup: "Einstellungen verlassen", programVersion: "Programmversion"
  },
  it: {
    welcome: "Benvenuto", chooseAction: "Scegli un'azione per iniziare la sessione", loadingPlaylists: "Caricamento playlist salvate...", liveTv: "TV in diretta", addFirstPlaylist: "Aggiungi la prima playlist", movies: "Film", series: "Serie", loaded: "Caricato", total: "totale", live: "diretta", checkingStorage: "Ricerca delle playlist salvate nel browser.", noPlaylists: "Nessuna playlist trovata. Aggiungine una per caricare i canali.", addPlaylist: "Aggiungi playlist", playlistManager: "Gestione playlist", tvGuideSearch: "Cerca guida TV", setup: "Impostazioni", logout: "Disconnetti", setupTitle: "Impostazioni registrazione", loginRequired: "Accesso richiesto", enableLogin: "Abilita accesso", masterCode: "Codice principale", adultCode: "Codice adulto", childCode: "Codice bambino", set: "Impostato", darkMode: "Modalità scura", lightMode: "Modalità chiara", buffer: "Buffer", off: "Disattivato", low: "Basso", medium: "Medio", high: "Alto", language: "Lingua", exitSetup: "Esci dalle impostazioni", programVersion: "Versione programma"
  },
  pt: {
    welcome: "Bem-vindo", chooseAction: "Escolha uma ação para iniciar a sessão", loadingPlaylists: "Carregando listas salvas...", liveTv: "TV ao vivo", addFirstPlaylist: "Adicione sua primeira lista", movies: "Filmes", series: "Séries", loaded: "Carregado", total: "total", live: "ao vivo", checkingStorage: "Procurando listas salvas no navegador.", noPlaylists: "Nenhuma lista encontrada. Adicione uma para carregar canais.", addPlaylist: "Adicionar lista", playlistManager: "Gerenciador de listas", tvGuideSearch: "Buscar guia de TV", setup: "Configuração", logout: "Sair", setupTitle: "Configuração de gravação", loginRequired: "Login necessário", enableLogin: "Ativar login", masterCode: "Código mestre", adultCode: "Código adulto", childCode: "Código infantil", set: "Definido", darkMode: "Modo escuro", lightMode: "Modo claro", buffer: "Buffer", off: "Desativado", low: "Baixo", medium: "Médio", high: "Alto", language: "Idioma", exitSetup: "Sair da configuração", programVersion: "Versão do programa"
  }
} as const;

export type AppTranslationKey = keyof typeof translations.en;

function readLanguage(): AppLanguage {
  try {
    const stored = localStorage.getItem(APP_LANGUAGE_KEY);
    if (APP_LANGUAGES.some((language) => language.code === stored)) return stored as AppLanguage;
  } catch {
    // Fall back to the browser language.
  }

  const browserLanguage = String(globalThis.navigator?.language || "en").slice(0, 2).toLowerCase();
  return APP_LANGUAGES.some((language) => language.code === browserLanguage)
    ? browserLanguage as AppLanguage
    : "en";
}

let currentLanguage = readLanguage();
const listeners = new Set<() => void>();

export function getAppLanguage(): AppLanguage {
  return currentLanguage;
}

export function setAppLanguage(language: AppLanguage): void {
  currentLanguage = language;
  document.documentElement.lang = language;
  try {
    localStorage.setItem(APP_LANGUAGE_KEY, language);
  } catch {
    // Keep the in-memory language when storage is unavailable.
  }
  listeners.forEach((listener) => listener());
}

export function translate(key: AppTranslationKey, language = currentLanguage): string {
  return translations[language][key] || translations.en[key];
}

export function useAppLanguage(): AppLanguage {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAppLanguage,
    getAppLanguage
  );
}

document.documentElement.lang = currentLanguage;