namespace Lab
{
    public class Logger
    {
        public void Write(string message) => System.Console.WriteLine(message);
        public void Write(int code) => Write(code.ToString());
    }
}
