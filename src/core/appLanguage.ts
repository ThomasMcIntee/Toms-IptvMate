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
    noPlaylists: "No playlists found. Open Playlist Manager and choose Add Playlist.",
    addPlaylist: "Add Playlist",
    help: "Help",
    helpClose: "Close",
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
    programVersion: "Program Version",
    childHours1: "Child Hours 1",
    childHours2: "Child Hours 2",
    childHoursTitle: "Child Login Hours",
    childHoursOff: "Off",
    childHoursSave: "Save Hours",
    childHoursDisable: "Turn Off",
    childHoursCancel: "Cancel",
    childHoursStart: "Start",
    childHoursEnd: "End",
    childHoursDays: "Days",
    childHoursAllDays: "Every Day",
    childHoursWeekdays: "Weekdays",
    childHoursWeekends: "Weekends",
    childHoursHelp: "Children can log in only during these times."
  },
  es: {
    welcome: "Bienvenido", chooseAction: "Elige una acción para iniciar tu sesión", loadingPlaylists: "Cargando listas guardadas...", liveTv: "TV en vivo", addFirstPlaylist: "Añade tu primera lista", movies: "Películas", series: "Series", loaded: "Cargado", total: "total", live: "en vivo", checkingStorage: "Buscando listas guardadas en el navegador.", noPlaylists: "No se encontraron listas. Ábrelo en Administrador de listas y elige Añadir lista.", addPlaylist: "Añadir lista", help: "Ayuda", helpClose: "Cerrar", playlistManager: "Administrador de listas", tvGuideSearch: "Buscar guía de TV", setup: "Configuración", logout: "Cerrar sesión", setupTitle: "Configuración de grabación", loginRequired: "Inicio de sesión requerido", enableLogin: "Activar inicio de sesión", masterCode: "Código maestro", adultCode: "Código adulto", childCode: "Código infantil", set: "Definido", darkMode: "Modo oscuro", lightMode: "Modo claro", buffer: "Búfer", off: "Desactivado", low: "Bajo", medium: "Medio", high: "Alto", language: "Idioma", exitSetup: "Salir de configuración", programVersion: "Versión del programa", childHours1: "Horario infantil 1", childHours2: "Horario infantil 2", childHoursTitle: "Horario de acceso infantil", childHoursOff: "Desactivado", childHoursSave: "Guardar horario", childHoursDisable: "Desactivar", childHoursCancel: "Cancelar", childHoursStart: "Inicio", childHoursEnd: "Fin", childHoursDays: "Días", childHoursAllDays: "Todos los días", childHoursWeekdays: "Días laborables", childHoursWeekends: "Fines de semana", childHoursHelp: "Los niños solo pueden iniciar sesión en estos horarios."
  },
  fr: {
    welcome: "Bienvenue", chooseAction: "Choisissez une action pour démarrer votre session", loadingPlaylists: "Chargement des listes enregistrées...", liveTv: "TV en direct", addFirstPlaylist: "Ajoutez votre première liste", movies: "Films", series: "Séries", loaded: "Chargé", total: "total", live: "direct", checkingStorage: "Recherche des listes enregistrées dans le navigateur.", noPlaylists: "Aucune liste trouvée. Ouvrez le gestionnaire de listes et choisissez Ajouter une liste.", addPlaylist: "Ajouter une liste", help: "Aide", helpClose: "Fermer", playlistManager: "Gestionnaire de listes", tvGuideSearch: "Recherche du guide TV", setup: "Configuration", logout: "Déconnexion", setupTitle: "Configuration des enregistrements", loginRequired: "Connexion requise", enableLogin: "Activer la connexion", masterCode: "Code principal", adultCode: "Code adulte", childCode: "Code enfant", set: "Défini", darkMode: "Mode sombre", lightMode: "Mode clair", buffer: "Tampon", off: "Désactivé", low: "Faible", medium: "Moyen", high: "Élevé", language: "Langue", exitSetup: "Quitter la configuration", programVersion: "Version du programme", childHours1: "Horaires enfant 1", childHours2: "Horaires enfant 2", childHoursTitle: "Horaires de connexion enfant", childHoursOff: "Désactivé", childHoursSave: "Enregistrer", childHoursDisable: "Désactiver", childHoursCancel: "Annuler", childHoursStart: "Début", childHoursEnd: "Fin", childHoursDays: "Jours", childHoursAllDays: "Tous les jours", childHoursWeekdays: "Jours de semaine", childHoursWeekends: "Week-end", childHoursHelp: "Les enfants ne peuvent se connecter que pendant ces horaires."
  },
  de: {
    welcome: "Willkommen", chooseAction: "Wähle eine Aktion, um deine Sitzung zu starten", loadingPlaylists: "Gespeicherte Wiedergabelisten werden geladen...", liveTv: "Live-TV", addFirstPlaylist: "Erste Wiedergabeliste hinzufügen", movies: "Filme", series: "Serien", loaded: "Geladen", total: "gesamt", live: "live", checkingStorage: "Browserspeicher wird nach Wiedergabelisten durchsucht.", noPlaylists: "Keine Wiedergabelisten gefunden. Öffne Wiedergabelisten verwalten und wähle Wiedergabeliste hinzufügen.", addPlaylist: "Wiedergabeliste hinzufügen", help: "Hilfe", helpClose: "Schließen", playlistManager: "Wiedergabelisten verwalten", tvGuideSearch: "TV-Guide-Suche", setup: "Einstellungen", logout: "Abmelden", setupTitle: "Aufnahmeeinstellungen", loginRequired: "Anmeldung erforderlich", enableLogin: "Anmeldung aktivieren", masterCode: "Mastercode", adultCode: "Erwachsenencode", childCode: "Kindercode", set: "Gesetzt", darkMode: "Dunkler Modus", lightMode: "Heller Modus", buffer: "Puffer", off: "Aus", low: "Niedrig", medium: "Mittel", high: "Hoch", language: "Sprache", exitSetup: "Einstellungen verlassen", programVersion: "Programmversion", childHours1: "Kinderzeiten 1", childHours2: "Kinderzeiten 2", childHoursTitle: "Kinder-Anmeldezeiten", childHoursOff: "Aus", childHoursSave: "Zeiten speichern", childHoursDisable: "Ausschalten", childHoursCancel: "Abbrechen", childHoursStart: "Beginn", childHoursEnd: "Ende", childHoursDays: "Tage", childHoursAllDays: "Jeden Tag", childHoursWeekdays: "Wochentage", childHoursWeekends: "Wochenende", childHoursHelp: "Kinder können sich nur in diesen Zeiten anmelden."
  },
  it: {
    welcome: "Benvenuto", chooseAction: "Scegli un'azione per iniziare la sessione", loadingPlaylists: "Caricamento playlist salvate...", liveTv: "TV in diretta", addFirstPlaylist: "Aggiungi la prima playlist", movies: "Film", series: "Serie", loaded: "Caricato", total: "totale", live: "diretta", checkingStorage: "Ricerca delle playlist salvate nel browser.", noPlaylists: "Nessuna playlist trovata. Apri Gestione playlist e scegli Aggiungi playlist.", addPlaylist: "Aggiungi playlist", help: "Guida", helpClose: "Chiudi", playlistManager: "Gestione playlist", tvGuideSearch: "Cerca guida TV", setup: "Impostazioni", logout: "Disconnetti", setupTitle: "Impostazioni registrazione", loginRequired: "Accesso richiesto", enableLogin: "Abilita accesso", masterCode: "Codice principale", adultCode: "Codice adulto", childCode: "Codice bambino", set: "Impostato", darkMode: "Modalità scura", lightMode: "Modalità chiara", buffer: "Buffer", off: "Disattivato", low: "Basso", medium: "Medio", high: "Alto", language: "Lingua", exitSetup: "Esci dalle impostazioni", programVersion: "Versione programma", childHours1: "Orari bambino 1", childHours2: "Orari bambino 2", childHoursTitle: "Orari di accesso bambino", childHoursOff: "Disattivato", childHoursSave: "Salva orari", childHoursDisable: "Disattiva", childHoursCancel: "Annulla", childHoursStart: "Inizio", childHoursEnd: "Fine", childHoursDays: "Giorni", childHoursAllDays: "Ogni giorno", childHoursWeekdays: "Giorni feriali", childHoursWeekends: "Fine settimana", childHoursHelp: "I bambini possono accedere solo in questi orari."
  },
  pt: {
    welcome: "Bem-vindo", chooseAction: "Escolha uma ação para iniciar a sessão", loadingPlaylists: "Carregando listas salvas...", liveTv: "TV ao vivo", addFirstPlaylist: "Adicione sua primeira lista", movies: "Filmes", series: "Séries", loaded: "Carregado", total: "total", live: "ao vivo", checkingStorage: "Procurando listas salvas no navegador.", noPlaylists: "Nenhuma lista encontrada. Abra o gerenciador de listas e escolha Adicionar lista.", addPlaylist: "Adicionar lista", help: "Ajuda", helpClose: "Fechar", playlistManager: "Gerenciador de listas", tvGuideSearch: "Buscar guia de TV", setup: "Configuração", logout: "Sair", setupTitle: "Configuração de gravação", loginRequired: "Login necessário", enableLogin: "Ativar login", masterCode: "Código mestre", adultCode: "Código adulto", childCode: "Código infantil", set: "Definido", darkMode: "Modo escuro", lightMode: "Modo claro", buffer: "Buffer", off: "Desativado", low: "Baixo", medium: "Médio", high: "Alto", language: "Idioma", exitSetup: "Sair da configuração", programVersion: "Versão do programa", childHours1: "Horário infantil 1", childHours2: "Horário infantil 2", childHoursTitle: "Horários de login infantil", childHoursOff: "Desativado", childHoursSave: "Salvar horário", childHoursDisable: "Desativar", childHoursCancel: "Cancelar", childHoursStart: "Início", childHoursEnd: "Fim", childHoursDays: "Dias", childHoursAllDays: "Todos os dias", childHoursWeekdays: "Dias úteis", childHoursWeekends: "Fim de semana", childHoursHelp: "Crianças só podem entrar nestes horários."
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