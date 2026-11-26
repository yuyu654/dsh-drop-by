using System;
using System.Runtime.InteropServices;

static class QunsHelper
{
    [DllImport("shell32.dll")]
    private static extern int SHQueryUserNotificationState(out int pquns);

    static int Main()
    {
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            if (line == "exit") break;
            int state;
            int hr = SHQueryUserNotificationState(out state);
            Console.WriteLine(hr == 0 ? state.ToString() : "-1");
            Console.Out.Flush();
        }
        return 0;
    }
}
