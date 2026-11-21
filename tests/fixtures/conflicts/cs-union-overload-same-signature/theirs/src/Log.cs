namespace Lab;

public class Log
{
    public void Write(string m)
    {
        System.Console.WriteLine(m);
    }

    public void Write(int value)
    {
        Write(value.ToString());
    }
}
