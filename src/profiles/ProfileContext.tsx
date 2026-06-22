import { createContext, useContext, useState } from "react";

type Profile = {
  id: string;
  name: string;
  history: any[];
};

const ProfileContext = createContext<{ profile: Profile }>({
  profile: { id: "1", name: "Thomas", history: [] }
});

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profile] = useState<Profile>({
    id: "1",
    name: "Thomas",
    history: []
  });

  return (
    <ProfileContext.Provider value={{ profile }}>
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile() {
  return useContext(ProfileContext);
}
