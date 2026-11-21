package lab;

public class Log {
    public void write(String m) {
        System.out.println(m);
    }

    public void write(double d) {
        write(Double.toString(d));
    }
}
