import { MembersDataProvider } from './members-data-context';

export default function MembersLayout({ children }) {
  return <MembersDataProvider>{children}</MembersDataProvider>;
}
