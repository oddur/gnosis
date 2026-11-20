namespace Lab
{
    public class Logger
    {
        public void Write(string message) => System.Console.WriteLine(message);
        public void Write(System.Exception error) => Write(error.Message);
    }
}
