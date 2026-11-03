import { AccountSwitcher } from './AccountSwitcher'

export function Header() {
  return (
    <header className="w-full bg-white shadow-xs px-6 flex h-16 items-center justify-between">
      {/* <div className=""> */}
      <div className="flex items-center gap-3">
        <img src="favicon.png" alt="" className="h-7 w-7" />
        <h1 className="text-lg font-semibold text-gray-800 sm:text-xl">星河AI直播</h1>
      </div>

      <div className="flex items-center">
        <AccountSwitcher />
      </div>
      {/* </div> */}
    </header>
  )
}
