namespace Lab;

public class Log
{
    public void Write(string m)
    {
        System.Console.WriteLine(m);
    }

    public void Write(int code)
    {
        Write("code " + code);
    }
}
